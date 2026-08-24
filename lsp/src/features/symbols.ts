/**
 * Document symbols and folding range providers for .ree templates.
 *
 * Symbols: Ree blocks ({#if}, {#each}, {#with}), components, includes, layouts.
 * Folding: Ree blocks, HTML/REE elements, script/style bodies, comments.
 */

import type { DocumentSymbol, FoldingRange, SymbolKind } from "vscode-languageserver";
import { SymbolKind as K } from "vscode-languageserver";

import { parse } from "../parser/parser";
import { scan } from "../parser/scanner";
import type { AstNode } from "../parser/ast";
import { offset_to_position } from "../documents/positions";

// ---------------------------------------------------------------------------
// Document Symbols
// ---------------------------------------------------------------------------

export function compute_symbols(text: string): DocumentSymbol[] {
	const tokens = scan(text);
	const { ast } = parse(tokens);
	return collect_symbols(ast, text);
}

function collect_symbols(node: AstNode, text: string): DocumentSymbol[] {
	const symbols: DocumentSymbol[] = [];

	if (node.type === "block" && node.block_type) {
		const kind = node.block_type === "if" ? K.Namespace :
			node.block_type === "each" ? K.Array :
			K.Struct;
		symbols.push({
			name: `{#${node.block_type}}`,
			kind,
			range: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
			selectionRange: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, Math.min(node.range.start + 5 + node.block_type.length, node.range.end)),
			},
			children: collect_children_symbols(node, text),
		});
		return symbols;
	}

	if (node.type === "component") {
		const name = node.tag_name ? `<${node.tag_name}>` : "Component";
		symbols.push({
			name,
			kind: K.Class,
			range: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
			selectionRange: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, Math.min(node.range.start + name.length, node.range.end)),
			},
			children: collect_children_symbols(node, text),
		});
		return symbols;
	}

	if (node.type === "include" && node.path_value) {
		symbols.push({
			name: `#include(${node.path_value})`,
			kind: K.File,
			range: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
			selectionRange: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
		});
		return symbols;
	}

	if (node.type === "layout" && node.path_value) {
		symbols.push({
			name: `#layout(${node.path_value})`,
			kind: K.File,
			range: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
			selectionRange: {
				start: offset_to_position(text, node.range.start),
				end: offset_to_position(text, node.range.end),
			},
		});
		return symbols;
	}

	// Recurse into children
	const child_symbols: DocumentSymbol[] = [];
	if (node.children) {
		for (const child of node.children) {
			child_symbols.push(...collect_symbols(child, text));
		}
	}
	if (node.else_branch) {
		child_symbols.push(...collect_symbols(node.else_branch, text));
	}
	return child_symbols;
}

function collect_children_symbols(node: AstNode, text: string): DocumentSymbol[] {
	const symbols: DocumentSymbol[] = [];
	if (node.children) {
		for (const child of node.children) {
			symbols.push(...collect_symbols(child, text));
		}
	}
	// Else branch: nest as a child with {:else} name
	if (node.else_branch) {
		symbols.push({
			name: "{:else}",
			kind: K.Namespace,
			range: {
				start: offset_to_position(text, node.else_branch.range.start),
				end: offset_to_position(text, node.else_branch.range.end),
			},
			selectionRange: {
				start: offset_to_position(text, node.else_branch.range.start),
				end: offset_to_position(text, Math.min(node.else_branch.range.start + 6, node.else_branch.range.end)),
			},
			children: collect_children_symbols(node.else_branch, text),
		});
	}
	return symbols;
}

// ---------------------------------------------------------------------------
// Folding Ranges
// ---------------------------------------------------------------------------

export function compute_folding_ranges(text: string): FoldingRange[] {
	const tokens = scan(text);
	const { ast } = parse(tokens);
	return collect_folds(ast, text);
}

function collect_folds(node: AstNode, text: string): FoldingRange[] {
	const folds: FoldingRange[] = [];

	// Foldable containers include both native HTML and hyphenated REE
	// components. The parser gives both the complete opening-to-closing range.
	const is_foldable = node.type === "block" || node.type === "element" || node.type === "component" || node.type === "script" || node.type === "style";

	if (is_foldable && node.range.start < node.range.end) {
		const start = offset_to_position(text, node.range.start);
		const end = offset_to_position(text, node.range.end);
		if (start.line < end.line) {
			folds.push({
				startLine: start.line,
				startCharacter: start.character,
				endLine: end.line,
				endCharacter: end.character,
			});
		}
	}

	// Recurse
	if (node.children) {
		for (const child of node.children) {
			folds.push(...collect_folds(child, text));
		}
	}
	if (node.else_branch) {
		folds.push(...collect_folds(node.else_branch, text));
	}

	return folds;
}
