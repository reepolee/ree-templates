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
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";

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
	preferred_locale?: string,
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

	// Translation key -> jump to the file that actually defines the key,
	// preferring the most specific locale directory for this template.
	if (token.type === "translation" && token.translation_key) {
		const from_file = file_uri_to_path(document_uri) ?? "";
		const candidates = profile?.translation_definition_files?.(from_file) ?? fallback_locale_files(profile, project_root);

		// A key defined in several locales resolves to the preferred one.
		const preferred = order_by_locale(candidates, preferred_locale);
		for (const file_path of preferred) {
			const pos = find_key_position(file_path, token.translation_key);
			if (!pos) continue;
			return {
				uri: pathToFileURL(file_path).href,
				range: { start: pos, end: { line: pos.line, character: pos.character + token.translation_key.length + 4 } },
			};
		}

		// Key is absent everywhere - open the preferred locale file so the
		// key can be added where it belongs.
		const first = preferred[0];
		if (first) {
			return {
				uri: pathToFileURL(first).href,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			};
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Locale file selection
// ---------------------------------------------------------------------------

/** Locale files from every translation root, used when a profile has no resolver. */
function fallback_locale_files(profile?: ReeProjectProfile | null, project_root?: string): string[] {
	const roots = profile?.translation_roots ?? (project_root ? [project_root] : []);
	const files: string[] = [];

	for (const root of roots) {
		if (!existsSync(root)) continue;
		try {
			const names = readdirSync(root).filter(is_locale_file);
			names.sort();
			for (const name of names) {
				files.push(join(root, name));
			}
		} catch {
			// Unreadable root
		}
	}

	return files;
}

/**
 * Move files for the preferred locale to the front, keeping the existing
 * specificity order within each group. Matching is case-insensitive so
 * `en-us.json` satisfies a preferred locale of `en-US`.
 */
function order_by_locale(files: string[], locale?: string): string[] {
	if (!locale) return files;

	const wanted = `${locale.toLowerCase()}.json`;
	const matching: string[] = [];
	const rest: string[] = [];

	for (const file_path of files) {
		const name = file_path.slice(file_path.lastIndexOf(sep) + 1).toLowerCase();
		if (name === wanted) {
			matching.push(file_path);
		} else {
			rest.push(file_path);
		}
	}

	return [...matching, ...rest];
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
			return dirname(fileURLToPath(uri));
		}
		return dirname(uri);
	} catch {
		return undefined;
	}
}

function file_uri_to_path(uri: string): string | undefined {
	try {
		// `new URL().pathname` yields "/C:/..." on Windows and leaves percent
		// escapes intact, which breaks path comparisons against project roots.
		if (uri.startsWith("file://")) {
			return fileURLToPath(uri);
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
 * Find the line/character position of a dotted key (e.g. "ui.title")
 * in a nested JSON file.
 *
 * Tracks the object path while scanning so that `ui.title` matches the
 * `"title"` nested inside `"ui"`, not the first `"title"` anywhere.
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
	const path: string[] = [];
	let pending_key: string | null = null;

	for (let line_index = 0; line_index < lines.length; line_index++) {
		const line = lines[line_index]!;
		const key_match = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
		const key = key_match ? key_match[1]! : null;

		if (key !== null) {
			// The outermost `{` contributes an unnamed level, so a key at the
			// document root sits at path length 1.
			const candidate = [...path.slice(1), key];
			if (candidate.length === segments.length && candidate.every((part, i) => part === segments[i])) {
				const character = line.indexOf(`"${key}"`);
				return { line: line_index, character: character >= 0 ? character : 0 };
			}
			pending_key = key;
		}

		// Apply brace movement after the key check so a key and its opening
		// brace on the same line nest correctly.
		for (const char of strip_strings(line)) {
			if (char === "{") {
				path.push(pending_key ?? "");
				pending_key = null;
			} else if (char === "}") {
				path.pop();
			}
		}

		if (key === null) pending_key = null;
	}

	return undefined;
}

/** Blank out string contents so braces inside values do not affect nesting. */
function strip_strings(line: string): string {
	return line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}
