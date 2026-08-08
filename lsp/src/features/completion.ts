/**
 * Completion provider for .ree templates.
 *
 * Offers:
 * - Block/directive snippets ({#if}, {#each}, {#with}, {#include}, {#layout}, {:else}, closers)
 * - Output/translation tag forms
 * - Built-in helper names (from profile or defaults)
 * - Translation keys inside translation tags (cached from project profile)
 */

import type { CompletionItem, CompletionItemKind, Position, Range } from "vscode-languageserver";
import { CompletionItemKind as K } from "vscode-languageserver";

import { offset_range, position_to_offset } from "../documents/positions";
import { is_locale_file, type ReeProjectProfile } from "../profiles/index";
import { DEFAULT_HELPER_NAMES } from "../profiles/helper_loader";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/** Cache of locale-file → translation key index, keyed by file path. */
const translation_cache = new Map<string, Map<string, string> | null>();

/** Invalidate the translation cache (called when files change). */
export function invalidate_translation_cache(): void {
	translation_cache.clear();
}

function get_translation_index(file_path: string, profile: ReeProjectProfile, from_ree_file?: string): Map<string, string> | null {
	const cache_key = from_ree_file ? `${file_path}::${from_ree_file}` : file_path;
	if (translation_cache.has(cache_key)) {
		return translation_cache.get(cache_key) ?? null;
	}

	const index = profile.load_translation_index?.(file_path, from_ree_file) ?? null;
	translation_cache.set(cache_key, index);
	return index;
}

// ---------------------------------------------------------------------------
// Snippet data
// ---------------------------------------------------------------------------

interface SnippetDef {
	label: string;
	detail: string;
	insertText: string;
	docs: string;
	kind: CompletionItemKind;
}

const BLOCK_SNIPPETS: SnippetDef[] = [
	{
		label: "{#if}",
		detail: "Block: if condition",
		insertText: "{#if $1}\n\t$0\n{/if}",
		docs: "Conditional block. Renders content when condition is truthy.",
		kind: K.Snippet,
	},
	{
		label: "{#each}",
		detail: "Block: each loop",
		insertText: "{#each ${1:list} as ${2:item}}\n\t$0\n{/each}",
		docs: "Iteration block. Loops over arrays and objects.",
		kind: K.Snippet,
	},
	{
		label: "{#each with else}",
		detail: "Block: each loop with else",
		insertText: "{#each ${1:list} as ${2:item}}\n\t$0\n{:else}\n\t\n{/each}",
		docs: "Iteration block with empty fallback.",
		kind: K.Snippet,
	},
	{
		label: "{#with}",
		detail: "Block: with scope",
		insertText: "{#with ${1:expr}}\n\t$0\n{/with}",
		docs: "Scope block. All bare identifiers inside resolve against the given expression.",
		kind: K.Snippet,
	},
	{
		label: "{#include}",
		detail: "Include partial",
		insertText: "{#include('${1:path}') }",
		docs: "Include another template inline.",
		kind: K.Snippet,
	},
	{
		label: "{#layout}",
		detail: "Layout wrapper",
		insertText: "{#layout('${1:path}') }",
		docs: "Wrap the current template in a layout.",
		kind: K.Snippet,
	},
	{
		label: "{:else}",
		detail: "Block: else branch",
		insertText: "{:else}",
		docs: "Else branch for {#if} or {#each}.",
		kind: K.Snippet,
	},
];

const OUTPUT_SNIPPETS: SnippetDef[] = [
	{
		label: "{= }",
		detail: "Escaped output",
		insertText: "{= $1 }",
		docs: "HTML-escaped expression output.",
		kind: K.Snippet,
	},
	{
		label: "{~ }",
		detail: "Raw output",
		insertText: "{~ $1 }",
		docs: "Unescaped / raw HTML output.",
		kind: K.Snippet,
	},
	{
		label: "{_ }",
		detail: "Escaped translation",
		insertText: "{_ $1 }",
		docs: "HTML-escaped translation lookup.",
		kind: K.Snippet,
	},
	{
		label: "{- }",
		detail: "Raw translation",
		insertText: "{- $1 }",
		docs: "Unescaped translation lookup.",
		kind: K.Snippet,
	},
	{
		label: "{@ }",
		detail: "Markdown translation",
		insertText: "{@ $1 }",
		docs: "Markdown translation lookup.",
		kind: K.Snippet,
	},
	{
		label: "{{ }}",
		detail: "Raw JavaScript block",
		insertText: "{{ $1 }}",
		docs: "Raw JavaScript code block.",
		kind: K.Snippet,
	},
];

// Fallback for when no profile is available (keeps server working standalone).
// When a profile is loaded, its helper_names come from the real source file.
const HELPER_NAMES = DEFAULT_HELPER_NAMES;

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

function detect_context(text: string, cursor_offset: number) {
	const prefix = text.slice(0, cursor_offset);
	const suffix = text.slice(cursor_offset);

	const last_brace = prefix.lastIndexOf("{");
	if (last_brace < 0) {
		return {
			is_after_open_brace: false,
			is_in_translation_tag: false,
			is_in_output_tag: false,
			is_in_block_tag: false,
			translation_prefix: null as string | null,
			directive_start_offset: null,
		};
	}

	const after_brace = prefix.slice(last_brace);
	const is_after_open_brace = /^\{(?:[#:/=~_@-])?$/.test(after_brace) || (after_brace === "{" && (suffix.length === 0 || /[}\s]/.test(suffix[0]!)));

	const trans_match = prefix.match(/\{[_@-]\s+([\w.]*)$/);
	const is_in_translation_tag = trans_match !== null;
	const translation_prefix = trans_match ? prefix[last_brace + 1]! : null;

	const output_match = prefix.match(/\{[=~]\s+([^}]*)$/);
	const is_in_output_tag = output_match !== null;

	const block_match = prefix.match(/\{#\s*$/);
	const is_in_block_tag = block_match !== null;

	const directive_start_offset = is_after_open_brace || is_in_block_tag ? last_brace : null;

	return {
		is_after_open_brace,
		is_in_translation_tag,
		is_in_output_tag,
		is_in_block_tag,
		translation_prefix,
		directive_start_offset,
	};
}

// ---------------------------------------------------------------------------
// Main completion entry point
// ---------------------------------------------------------------------------

export function compute_completions(text: string, position: Position, profile?: ReeProjectProfile | null, document_uri?: string): CompletionItem[] {
	const offset = position_to_offset(text, position);
	const ctx = detect_context(text, offset);
	const directive_replacement_range = ctx.directive_start_offset === null
		? undefined
		: offset_range(text, ctx.directive_start_offset, offset);

	const items: CompletionItem[] = [];

	if (ctx.is_after_open_brace || ctx.is_in_block_tag) {
		for (const s of BLOCK_SNIPPETS) {
			items.push(to_completion_item(s, directive_replacement_range));
		}
		for (const s of OUTPUT_SNIPPETS) {
			items.push(to_completion_item(s, directive_replacement_range));
		}
	}

	if (ctx.is_in_output_tag) {
		const helpers = profile?.helper_names ?? HELPER_NAMES;
		for (const name of helpers) {
			items.push({
				label: name,
				kind: K.Function,
				detail: "Built-in helper",
			});
		}
	}

	if (ctx.is_in_translation_tag && ctx.translation_prefix) {
		// Load translation keys from ALL locale files (cached per file)
		if (profile?.translation_roots) {
			for (const root of profile.translation_roots) {
				if (!existsSync(root)) continue;
				try {
					const files = readdirSync(root).filter(is_locale_file);
					// Load all locale indexes
					const indexes: { locale: string; index: Map<string, string> | null }[] = [];
					for (const file of files) {
						const full_path = join(root, file);
						const from_file = document_uri ? file_uri_to_path(document_uri) : undefined;
						const index = get_translation_index(full_path, profile, from_file);
						indexes.push({ locale: file.replace(/\.json$/, ""), index });
					}

					// Collect all keys from the first index that exists
					const primary = indexes.find(i => i.index !== null);
					if (primary?.index) {
						for (const key of primary.index.keys()) {
							// Build multi-locale detail: "Welcome" (en-US) / "Dobrodošli" (sl-SI)
							const parts: string[] = [];
							for (const { locale, index } of indexes) {
								const val = index?.get(key);
								if (val !== undefined) {
									parts.push(`"${val}" (${locale})`);
								}
							}
							items.push({
								label: key,
								kind: K.Constant,
								detail: parts.length > 0 ? parts.join(" / ") : "Translation key",
							});
						}
					}
				} catch {
					// Silently skip unreadable translation roots
				}
				break;
			}
		}

		// Fallback: single example key when no profile is available
		if (items.length === 0 || items.every(i => i.kind !== K.Constant)) {
			items.push({
				label: "ui.title",
				kind: K.Constant,
				detail: "Example translation key (no project profile loaded)",
			});
		}
	}

	if (!ctx.is_after_open_brace && !ctx.is_in_block_tag && !ctx.is_in_translation_tag) {
		const helpers = profile?.helper_names ?? HELPER_NAMES;
		for (const name of helpers) {
			items.push({
				label: name,
				kind: K.Function,
				detail: "Built-in helper",
			});
		}
	}

	return items;
}

function to_completion_item(s: SnippetDef, replacement_range?: Range): CompletionItem {
	const item: CompletionItem = {
		label: s.label,
		kind: s.kind,
		detail: s.detail,
		insertTextFormat: 2,
		documentation: s.docs,
	};

	if (replacement_range) {
		item.textEdit = { range: replacement_range, newText: s.insertText };
	} else {
		item.insertText = s.insertText;
	}

	return item;
}

function file_uri_to_path(uri: string): string | undefined {
	try {
		if (uri.startsWith("file://")) return fileURLToPath(uri);
		return uri;
	} catch {
		return undefined;
	}
}
