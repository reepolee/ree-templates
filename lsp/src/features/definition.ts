/**
 * Go-to-definition provider for .ree templates.
 *
 * Supports:
 * - Literal includes and layouts (via project profile path semantics)
 * - Component tags (via profile component resolution)
 * - Translation keys (via profile translation index)
 *
 * Falls back to basic resolution when no profile is available.
 */

import type { Location, Position } from "vscode-languageserver";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { find_token_at } from "../parser/contexts";
import { position_to_offset } from "../documents/positions";
import { is_locale_file, type ReeProjectProfile } from "../profiles/index";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function find_definition(
	text: string,
	position: Position,
	document_uri: string,
	project_root?: string,
	profile?: ReeProjectProfile | null,
): Location | undefined {
	const offset = position_to_offset(text, position);
	const token = find_token_at(text, offset);
	if (!token) return undefined;

	// Include/layout path → use profile resolver if available
	if ((token.type === "include" || token.type === "layout") && token.path_value) {
		if (profile) {
			const from_file = file_uri_to_path(document_uri) ?? "";
			const target = profile.resolve_include(token.path_value, from_file);
			if (target) {
				return {
					uri: pathToFileURL(target.file_path).href,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				};
			}
		}
		// Fallback to basic resolution
		return basic_include_target(token.path_value, document_uri, project_root);
	}

	// Component tag → use profile resolver if available
	if ((token.type === "component_open" || token.type === "component_close" || token.type === "component_self_close") && token.tag_name) {
		if (profile) {
			const target = profile.resolve_component(token.tag_name);
			if (target) {
				return {
					uri: pathToFileURL(target.file_path).href,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				};
			}
		}
		return basic_component_target(token.tag_name, project_root);
	}

	// Translation key → jump to key position in the first locale JSON file
	if (token.type === "translation" && token.translation_key) {
		const from_file = file_uri_to_path(document_uri) ?? "";
		const definition_files = profile?.translation_definition_files?.(from_file);
		if (definition_files) {
			for (const file_path of definition_files) {
				const pos = find_key_position(file_path, token.translation_key);
				if (!pos) continue;
				return {
					uri: pathToFileURL(file_path).href,
					range: { start: pos, end: { line: pos.line, character: pos.character + token.translation_key.length + 4 } },
				};
			}
		}

		const roots = profile?.translation_roots ?? (project_root ? [join(project_root, ".reepolee", "i18n")] : []);
		for (const root of roots) {
			if (!existsSync(root)) continue;
			try {
				const files = readdirSync(root).filter(is_locale_file);
				if (files.length === 0) continue;
				const file_path = join(root, files[0]!);
				const pos = find_key_position(file_path, token.translation_key);
				if (pos) {
					return {
						uri: pathToFileURL(file_path).href,
						range: { start: pos, end: { line: pos.line, character: pos.character + token.translation_key.length + 4 } },
					};
				}
				// Key not found in this file - still jump to the file
				return {
					uri: pathToFileURL(file_path).href,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				};
			} catch {
				// Unreadable root
			}
			break;
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Basic resolution (when no profile is available)
// ---------------------------------------------------------------------------

function basic_include_target(path_value: string, document_uri: string, project_root?: string): Location | undefined {
	if (!project_root) return undefined;

	let resolved: string | undefined;

	if (path_value.startsWith("$components/")) {
		resolved = resolve_file(join(project_root, "components", path_value.replace("$components/", "")));
	} else if (path_value.startsWith("$routes/")) {
		resolved = resolve_file(join(project_root, "routes", path_value.replace("$routes/", "")));
	} else if (path_value.startsWith("$lib/")) {
		resolved = resolve_file(join(project_root, "lib", path_value.replace("$lib/", "")));
	} else if (path_value.startsWith("./") || path_value.startsWith("../")) {
		const doc_dir = file_uri_to_dir(document_uri) ?? project_root;
		resolved = resolve_file(join(doc_dir, path_value));
	} else {
		const clean = path_value.startsWith("/") ? path_value.slice(1) : path_value;
		resolved = resolve_file(join(project_root, "routes", clean));
	}

	if (resolved) {
		return {
			uri: pathToFileURL(resolved).href,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		};
	}

	return undefined;
}

function basic_component_target(tag_name: string, project_root?: string): Location | undefined {
	if (!project_root) return undefined;
	const file_path = resolve_file(join(project_root, "components", tag_name));
	if (file_path) {
		return {
			uri: pathToFileURL(file_path).href,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolve_file(base_path: string): string | undefined {
	if (existsSync(base_path + ".ree")) return base_path + ".ree";
	if (existsSync(base_path)) return base_path;
	return undefined;
}

function file_uri_to_dir(uri: string): string | undefined {
	try {
		if (uri.startsWith("file://")) {
			return dirname(new URL(uri).pathname);
		}
		return dirname(uri);
	} catch {
		return undefined;
	}
}

function file_uri_to_path(uri: string): string | undefined {
	try {
		if (uri.startsWith("file://")) {
			return new URL(uri).pathname;
		}
		return uri;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Find key position in JSON file
// ---------------------------------------------------------------------------

/**
 * Find the line/character position of a dotted key (e.g. "labels.row_count")
 * in a potentially nested JSON file.
 *
 * Walks line-by-line tracking the current nesting path so that
 * `routes.nav.home` resolves to the correct `"home"` inside `"nav"`
 * inside `"routes"`, not the first `"home"` anywhere in the file.
 */
function find_key_position(file_path: string, dotted_key: string): { line: number; character: number } | undefined {
	let text: string;
	try {
		text = readFileSync(file_path, "utf-8");
	} catch {
		return undefined;
	}

	const segments = dotted_key.split(".");
	if (segments.length === 0) return undefined;

	const lines = text.split("\n");
	const path_stack: string[] = [];

	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;

		// Track object depth: count { vs } to know when we exit an object
		for (const ch of line) {
			if (ch === "{") path_stack.push("");
			if (ch === "}") path_stack.pop();
		}

		// Extract key from "key": or "key" : pattern
		const key_match = line.match(/^\s*"([^"]+)"\s*:/);
		if (!key_match) continue;

		const key = key_match[1]!;

		// Update the path at the current nesting depth
		const depth = path_stack.length;
		// Trim path_stack to depth (accounting for keys at same level)
		while (path_stack.length > 0 && path_stack[path_stack.length - 1] === "") {
			path_stack.pop();
		}

		// Build the current path from the stack + this key
		// The stack contains ancestor keys at each nesting level
		// We need to match: segments[0] at depth 0, segments[1] at depth 1, etc.
		const expected_depth = segments.length - 1;

		// Check if this key matches the last segment at the right depth
		if (key === segments[segments.length - 1]) {
			// Verify ancestors by walking up the file
			if (matches_ancestors(lines, li, segments.slice(0, -1))) {
				const char = line.indexOf(`"${key}"`);
				return { line: li, character: char >= 0 ? char : 0 };
			}
		}
	}

	return undefined;
}

/** Walk backward from a line to verify ancestor keys exist in enclosing objects. */
function matches_ancestors(lines: string[], from_line: number, ancestors: string[]): boolean {
	if (ancestors.length === 0) return true;

	let depth = 0;
	const needed = [...ancestors]; // shallow copy, we match from innermost outward

	for (let li = from_line - 1; li >= 0 && needed.length > 0; li--) {
		const line = lines[li]!;

		// Track braces
		for (const ch of line) {
			if (ch === "}") depth++;
			if (ch === "{") depth--;
		}

		// At depth 0, we're at the right nesting level for the next ancestor
		if (depth === 0) {
			const key_match = line.match(/^\s*"([^"]+)"\s*:/);
			if (key_match && key_match[1] === needed[needed.length - 1]) {
				needed.pop();
				depth = 1; // move to next outer level
			}
		}
	}

	return needed.length === 0;
}
