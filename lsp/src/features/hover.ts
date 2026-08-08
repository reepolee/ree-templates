/**
 * Hover provider for .ree templates.
 *
 * Shows documentation for:
 * - Ree constructs ({#if}, {= }, {_ }, components, etc.)
 * - Built-in helper names
 * - Translation values from ALL available locales
 * - Resolved project targets (include/layout paths, component files)
 */

import type { Hover, Position } from "vscode-languageserver";

import { find_token_at, get_word_at } from "../parser/contexts";
import { position_to_offset } from "../documents/positions";
import { is_locale_file, type ReeProjectProfile } from "../profiles/index";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

const translation_cache = new Map<string, Map<string, string> | null>();

export function invalidate_translation_cache(): void {
	translation_cache.clear();
}

// ---------------------------------------------------------------------------
// Documentation maps
// ---------------------------------------------------------------------------

const DIRECTIVE_DOCS: Record<string, string> = {
	"{#if}": "**Conditional block**\n\nRenders content when the condition is truthy. Supports `{:else}` branch.\n\n```ree\n{#if props.user}\n  <p>Hello</p>\n{:else}\n  <p>Please log in</p>\n{/if}\n```",
	"{#each}": "**Iteration block**\n\nLoops over arrays and objects. Supports `{:else}` for empty lists.\n\n```ree\n{#each items as item}\n  <li>{= item.name }</li>\n{:else}\n  <p>No items</p>\n{/each}\n```",
	"{#with}": "**Scope block**\n\nSets the scope context. Bare identifiers resolve against the expression.\n\n```ree\n{#with props.record}\n  <h1>{= title }</h1>\n{/with}\n```",
	"{#include}": "**Include partial**\n\nIncludes another template inline.\n\n```ree\n{#include('partials/nav') }\n{#include('partials/card', { title, href }) }\n```",
	"{#layout}": "**Layout wrapper**\n\nWraps this template in a layout.\n\n```ree\n{#layout('layouts/base') }\n```",
	"{= }": "**Escaped output** - HTML-escaped expression. `{= user.name }`",
	"{~ }": "**Raw output** - Unescaped HTML. Use only with trusted content.",
	"{_ }": "**Escaped translation** - Safe translation lookup. Missing key renders `{key}` marker.",
	"{- }": "**Raw translation** - Unescaped translation. Use for trusted markup.",
	"{@ }": "**Markdown translation** - Translation rendered through markdown to HTML.",
	"{{ }}": "**Raw JavaScript** - Arbitrary JS code block.",
	"{:else}": "**Else branch** for `{#if}` or `{#each}` blocks.",
};

const HELPER_DOCS: Record<string, string> = {
	"url": "`url(path)` - Ensures a path starts with `/`.",
	"localized_path": "`localized_path(path)` - Converts a canonical URL to the current locale's version.",
	"yes_no": "`yes_no(value, type?)` - Displays a boolean as styled Yes/No.",
	"display_currency": "`display_currency(val, locale?, hide_zero?, symbol?)` - Formats as currency.",
	"display_percent": "`display_percent(val, locale?)` - Formats as percentage.",
	"md": "`md(source)` - Renders markdown to HTML.",
	"image_thumbnail": "`image_thumbnail(src, size?)` - Renders a square thumbnail `<img>`.",
	"file_link": "`file_link(src)` - Renders a download link.",
	"nav_label": "`nav_label(key, nav?)` - Looks up a navigation label.",
	"is_current": "`is_current(pageUrl)` - CSS classes for current page highlighting.",
	"key_values": "`key_values(obj)` - Renders object as HTML attributes.",
	"human_bytes": "`human_bytes(bytes)` - Formats bytes as human-readable.",
	"pill": "`pill(text, className)` - Styled `<div>` wrapper.",
	"tags": "`tags(val, colorClass?, translations?)` - Renders tags as pills.",
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function compute_hover(text: string, position: Position, profile?: ReeProjectProfile | null, document_uri?: string): Hover | undefined {
	const offset = position_to_offset(text, position);
	const token = find_token_at(text, offset);

	let doc: string | undefined;

	if (token) {
		doc = hover_for_token(token, profile, document_uri);
	}

	if (!doc) {
		const word = get_word_at(text, offset);
		if (word && HELPER_DOCS[word]) {
			doc = HELPER_DOCS[word];
		}
	}

	if (!doc) return undefined;

	return {
		contents: { kind: "markdown" as const, value: doc },
	};
}

// ---------------------------------------------------------------------------
// Token → documentation
// ---------------------------------------------------------------------------

function hover_for_token(token: import("../parser/ast").Token, profile?: ReeProjectProfile | null, document_uri?: string): string | undefined {
	switch (token.type) {
		case "block_open":
			if (token.block_type === "if") return DIRECTIVE_DOCS["{#if}"];
			if (token.block_type === "each") return DIRECTIVE_DOCS["{#each}"];
			if (token.block_type === "with") return DIRECTIVE_DOCS["{#with}"];
			break;
		case "block_else":
			return DIRECTIVE_DOCS["{:else}"];
		case "output":
			return token.prefix === "~" ? DIRECTIVE_DOCS["{~ }"] : DIRECTIVE_DOCS["{= }"];
		case "translation": {
			const prefix = token.prefix ?? "_";
			const directive_key = prefix === "_" ? "{_ }" : prefix === "-" ? "{- }" : "{@ }";
			let doc = DIRECTIVE_DOCS[directive_key] ?? "";

			if (token.translation_key) {
				doc += `\n\n**Key:** \`${token.translation_key}\`\n\n`;

				if (profile) {
					const values = lookup_all_locale_values(token.translation_key, profile, document_uri);
					if (values.length > 0) {
						for (const { locale, value } of values) {
							doc += `\`${value}\`\n- *${locale.toUpperCase()}*\n\n`;
						}
					} else {
						doc += "_(key not found in export - may still exist in DB)_";
					}
				}
			}

			return doc;
		}
		case "raw_js":
			return DIRECTIVE_DOCS["{{ }}"];
		case "include":
			return DIRECTIVE_DOCS["{#include}"] + (token.path_value ? `\n\nPath: \`${token.path_value}\`` : "");
		case "layout":
			return DIRECTIVE_DOCS["{#layout}"] + (token.path_value ? `\n\nPath: \`${token.path_value}\`` : "");
		case "component_open":
		case "component_close":
		case "component_self_close":
			if (token.tag_name) return `**ReeTag component** \`<${token.tag_name}>\`\n\nRenders from \`$components/${token.tag_name}.ree\`.`;
			break;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Multi-locale value lookup
// ---------------------------------------------------------------------------

function lookup_all_locale_values(key: string, profile: ReeProjectProfile, document_uri?: string): { locale: string; value: string }[] {
	const results: { locale: string; value: string }[] = [];

	for (const root of profile.translation_roots) {
		if (!existsSync(root)) continue;
		try {
			const files = readdirSync(root).filter(is_locale_file);
			files.sort();
			for (const file of files) {
				const locale = file.replace(/\.json$/, "");
				const full_path = join(root, file);
				const from_file = document_uri ? file_uri_to_path(document_uri) : undefined;
				const cache_key = from_file ? `${full_path}::${from_file}` : full_path;

				let index: Map<string, string> | null;
				if (translation_cache.has(cache_key)) {
					index = translation_cache.get(cache_key) ?? null;
				} else {
					index = profile.load_translation_index?.(full_path, from_file) ?? null;
					translation_cache.set(cache_key, index);
				}

				if (index?.has(key)) {
					results.push({ locale, value: index.get(key)! });
				}
			}
		} catch {
			// Skip unreadable roots
		}
		break; // Only process first translation root
	}

	return results;
}

function file_uri_to_path(uri: string): string | undefined {
	try {
		if (uri.startsWith("file://")) return fileURLToPath(uri);
		return uri;
	} catch {
		return undefined;
	}
}
