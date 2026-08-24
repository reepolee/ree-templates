/**
 * Tolerant structural parser for .ree templates.
 *
 * Consumes a flat token stream from the scanner and produces a
 * hierarchical AST. Handles recovery from malformed / incomplete
 * input - a broken document never causes a crash or drops content.
 */

import type { Token, AstNode, SourceRange } from "./ast";
import { leaf, container } from "./ast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParseState {
	tokens: Token[];
	pos: number;
	errors: { range: SourceRange; message: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function at_end(s: ParseState): boolean {
	return s.pos >= s.tokens.length;
}

function peek(s: ParseState): Token | undefined {
	return s.tokens[s.pos];
}

function advance(s: ParseState): Token | undefined {
	return s.tokens[s.pos++];
}

function range_span(start: SourceRange, end: SourceRange): SourceRange {
	return { start: start.start, end: end.end };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parse(tokens: Token[], scanner_errors?: { range: SourceRange; message: string }[]): { ast: AstNode; errors: { range: SourceRange; message: string }[] } {
	const s: ParseState = {
		tokens,
		pos: 0,
		errors: scanner_errors ? [...scanner_errors] : [],
	};

	const children = parse_block(s, () => at_end(s) || is_block_closer(s));

	const ast = container("document", { start: 0, end: s.tokens.length > 0 ? s.tokens[s.tokens.length - 1]!.range.end : 0 }, children);
	return { ast, errors: s.errors };
}

// ---------------------------------------------------------------------------
// Block parsing (sequences of nodes until a stop condition)
// ---------------------------------------------------------------------------

/**
 * Parse a flat sequence of child nodes until `stop` returns true or EOF.
 */
function parse_block(s: ParseState, stop: () => boolean): AstNode[] {
	const children: AstNode[] = [];

	while (!at_end(s) && !stop()) {
		const node = parse_statement(s);
		if (node) children.push(node);
	}

	return children;
}

/**
 * Check if the current token would close an enclosing block/tag.
 */
function is_block_closer(s: ParseState): boolean {
	const t = peek(s);
	if (!t) return false;
	return t.type === "block_close" || t.type === "block_else" || t.type === "tag_close" || t.type === "component_close";
}

// ---------------------------------------------------------------------------
// Statement dispatcher
// ---------------------------------------------------------------------------

function parse_statement(s: ParseState): AstNode | null {
	const t = peek(s);
	if (!t) return null;

	switch (t.type) {
		case "text":
			advance(s);
			return leaf("text", t.range);

		case "comment":
			advance(s);
			return leaf("comment", t.range);

		case "script_body":
			advance(s);
			return leaf("script", t.range);

		case "style_body":
			advance(s);
			return leaf("style", t.range);

		case "pre_body":
			advance(s);
			return leaf("element", t.range, { tag_name: "pre" });

		case "raw_js":
			advance(s);
			return leaf("raw_js", t.range);

		case "output":
			advance(s);
			return leaf("output", t.range, { prefix: t.prefix, expression: t.expression });

		case "translation":
			advance(s);
			return leaf("translation", t.range, { prefix: t.prefix, translation_key: t.translation_key });

		case "include":
			advance(s);
			return leaf("include", t.range, { path_value: t.path_value });

		case "layout":
			advance(s);
			return leaf("layout", t.range, { path_value: t.path_value });

		case "error":
			advance(s);
			return leaf("error", t.range, { recovery: true });

		case "block_open":
			return parse_block_structure(s);

		case "tag_open":
		case "tag_self_close":
			return parse_html_element(s);

		case "component_open":
		case "component_self_close":
			return parse_component(s);

		case "block_close":
		case "block_else":
			// Unexpected closer - treat as error
			advance(s);
			return leaf("error", t.range, { recovery: true, error_message: `Unexpected ${t.type}` });

		default:
			// Unknown token - consume and continue
			advance(s);
			return leaf("error", t.range, { recovery: true });
	}
}

// ---------------------------------------------------------------------------
// Block structures: {#if}...{:else}...{/if}, {#each}, {#with}, {#switch}
// ---------------------------------------------------------------------------

function parse_block_structure(s: ParseState): AstNode {
	const open = advance(s)!;
	const block_type = open.block_type!;
	const start_range = open.range;

	if (block_type === "switch") {
		return parse_switch_block(s, start_range);
	}

	const children: AstNode[] = [];
	let else_branch: AstNode | undefined;
	let close_range: SourceRange | undefined;

	while (!at_end(s)) {
		const t = peek(s)!;

		if (t.type === "block_else") {
			// {:else} - switch to else branch
			advance(s);
			const else_children = parse_block(s, () => at_end(s) || (peek(s)!.type === "block_close" && peek(s)!.block_type === block_type));
			if (else_children.length > 0) {
				else_branch = container("block", { start: t.range.start, end: else_children[else_children.length - 1]!.range.end }, else_children, { block_type, recovery: false });
			}
			continue;
		}

		if (t.type === "block_close" && t.block_type === block_type) {
			// Matching closer
			advance(s);
			close_range = t.range;
			break;
		}

		if (t.type === "block_close" && t.block_type !== block_type) {
			// Mismatched closer - record error but close to prevent cascading
			s.errors.push({ range: t.range, message: `Mismatched closing block: expected {/${block_type}}, got {/${t.block_type}}` });
			advance(s);
			close_range = t.range;
			break;
		}

		const node = parse_statement(s);
		if (node) children.push(node);
	}

	if (!close_range) {
		// Unclosed block
		s.errors.push({ range: start_range, message: `Unclosed {#${block_type}} block` });
	}

	const end_range = close_range ?? (children.length > 0 ? children[children.length - 1]!.range : start_range);

	return container("block", range_span(start_range, end_range), children, {
		block_type,
		else_branch,
		recovery: !close_range,
	});
}

/**
 * Parse a {#switch} ... {#case} ... {:else} ... {/switch} block.
 */
function parse_switch_block(s: ParseState, start_range: SourceRange): AstNode {
	const case_branches: { condition: string; children: AstNode[] }[] = [];
	let else_branch: AstNode | undefined;
	let close_range: SourceRange | undefined;

	/** Are we at a boundary that ends the current case body? */
	function at_case_boundary(): boolean {
		if (at_end(s)) return true;
		const pk = peek(s)!;
		if (pk.type === "block_close" && pk.block_type === "switch") return true;
		if (pk.type === "block_else") return true;
		if (pk.type === "block_open" && pk.block_type === "case") return true;
		return false;
	}

	while (!at_end(s)) {
		const t = peek(s)!;

		if (t.type === "block_open" && t.block_type === "case") {
			const case_token = advance(s)!;
			const condition = case_token.expression ?? "";
			const case_children = parse_block(s, at_case_boundary);
			case_branches.push({ condition, children: case_children });
			continue;
		}

		if (t.type === "block_else") {
			advance(s);
			const else_children = parse_block(s, at_case_boundary);
			if (else_children.length > 0) {
				else_branch = container("block", { start: t.range.start, end: else_children[else_children.length - 1]!.range.end }, else_children, { block_type: "switch", recovery: false });
			}
			continue;
		}

		if (t.type === "block_close" && t.block_type === "switch") {
			advance(s);
			close_range = t.range;
			break;
		}

		if (t.type === "block_close" && t.block_type !== "switch") {
			s.errors.push({ range: t.range, message: `Mismatched closing block: expected {/switch}, got {/${t.block_type}}` });
			advance(s);
			close_range = t.range;
			break;
		}

		// Tokens outside any case branch ({#switch} ... first {#case}):
		// skip them silently. Whitespace between switch and first case is
		// normal. Other content here is author error but the LSP
		// shouldn't noise about it — the runtime handles malformed input.
		parse_statement(s);
	}

	if (!close_range) {
		s.errors.push({ range: start_range, message: "Unclosed {#switch} block" });
	}

	const end_range = close_range ?? start_range;

	return container("block", range_span(start_range, end_range), [], {
		block_type: "switch",
		case_branches,
		else_branch,
		recovery: !close_range,
	});
}

// ---------------------------------------------------------------------------
// HTML elements: <div>...</div>
// ---------------------------------------------------------------------------

function parse_html_element(s: ParseState): AstNode {
	const open = advance(s)!;

	if (open.self_closing) {
		return leaf("element", open.range, { tag_name: open.tag_name, attributes: open.attributes, self_closing: true });
	}

	const tag_name = open.tag_name!;
	const children: AstNode[] = [];

	while (!at_end(s)) {
		const t = peek(s)!;

		if (t.type === "tag_close" && t.tag_name === tag_name) {
			advance(s);
			return container("element", range_span(open.range, t.range), children, { tag_name, attributes: open.attributes });
		}

		if (t.type === "tag_close") {
			// A closing tag for an ancestor belongs to the ancestor, not this
			// element. Leave it for the enclosing parser so malformed nesting does
			// not swallow the remainder of the document.
			if (t.tag_name !== tag_name) {
				return container("element", open.range, children, { tag_name, attributes: open.attributes, recovery: true });
			}
		}

		const node = parse_statement(s);
		if (node) children.push(node);
	}

	// Unclosed element
	s.errors.push({ range: open.range, message: `Unclosed <${tag_name}>` });
	return container("element", open.range, children, { tag_name, attributes: open.attributes, recovery: true });
}

// ---------------------------------------------------------------------------
// ReeTag components: <comp-name>...</comp-name>
// ---------------------------------------------------------------------------

function parse_component(s: ParseState): AstNode {
	const open = advance(s)!;

	if (open.self_closing) {
		return leaf("component", open.range, { tag_name: open.tag_name, attributes: open.attributes, self_closing: true });
	}

	const tag_name = open.tag_name!;
	const children: AstNode[] = [];

	while (!at_end(s)) {
		const t = peek(s)!;

		if (t.type === "component_close" && t.tag_name === tag_name) {
			advance(s);
			return container("component", range_span(open.range, t.range), children, { tag_name, attributes: open.attributes });
		}

		if (t.type === "component_close") {
			// Leave ancestor component closers for the enclosing parser.
			if (t.tag_name !== tag_name) {
				return container("component", open.range, children, { tag_name, attributes: open.attributes, recovery: true });
			}
		}

		const node = parse_statement(s);
		if (node) children.push(node);
	}

	s.errors.push({ range: open.range, message: `Unclosed <${tag_name}> component` });
	return container("component", open.range, children, { tag_name, attributes: open.attributes, recovery: true });
}

/**
 * Reparse with fresh state - exported for testing.
 */
export { type ParseState };
