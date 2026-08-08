/**
 * Tolerant scanner for .ree templates.
 *
 * Converts source text into a flat token stream. Never throws on
 * incomplete / malformed editor input. Tracks braces, strings, and
 * tags so embedded JS/CSS/comments don't confuse the tokenizer.
 */

import type { Token, TokenType, SourceRange } from "./ast";

// ---------------------------------------------------------------------------
// Scanner state
// ---------------------------------------------------------------------------

interface ScanState {
	source: string;
	pos: number;
	length: number;
}

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function at_end(s: ScanState): boolean {
	return s.pos >= s.length;
}

function peek(s: ScanState, n = 0): string {
	return s.source[s.pos + n] ?? "";
}

function advance(s: ScanState, n = 1): void {
	s.pos += n;
}

/** Slice from current pos to end. */
function slice_from(s: ScanState, start: number): string {
	return s.source.slice(start, s.pos);
}

/** Build a range from `start` to current position. */
function range_from(s: ScanState, start: number): SourceRange {
	return { start, end: s.pos };
}

function is_alpha(ch: string): boolean {
	return /[a-zA-Z]/.test(ch);
}

function is_alphanum(ch: string): boolean {
	return /[a-zA-Z0-9]/.test(ch);
}

function is_whitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

/** HTML void elements that are always self-closing (never have closing tags). */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function is_void_element(tag_name: string): boolean {
	return VOID_ELEMENTS.has(tag_name);
}

// ---------------------------------------------------------------------------
// Token builder
// ---------------------------------------------------------------------------

let tokens: Token[] = [];
let errors: { range: SourceRange; message: string }[] = [];

function push(t: Token): void {
	tokens.push(t);
}

export function get_tokens(): Token[] {
	return tokens;
}

export function get_errors(): { range: SourceRange; message: string }[] {
	return errors;
}

export function reset(): void {
	tokens = [];
	errors = [];
}

// ---------------------------------------------------------------------------
// Main scanner entry point
// ---------------------------------------------------------------------------

export function scan(source: string): Token[] {
	reset();
	const s: ScanState = { source, pos: 0, length: source.length };

	while (!at_end(s)) {
		// Try each token pattern in priority order
		if (try_scan_comment(s)) continue;
		if (try_scan_script_style(s)) continue;
		if (try_scan_pre_textarea(s)) continue;
		if (try_scan_raw_js(s)) continue;
		if (try_scan_ree_directive(s)) continue;
		if (try_scan_tag(s)) continue;
		// Fallback: consume as literal text
		scan_text(s);
	}

	return tokens;
}

// ---------------------------------------------------------------------------
// HTML comment: <!-- ... -->
// ---------------------------------------------------------------------------

function try_scan_comment(s: ScanState): boolean {
	if (peek(s, 0) !== "<" || peek(s, 1) !== "!" || peek(s, 2) !== "-" || peek(s, 3) !== "-") return false;

	const start = s.pos;
	advance(s, 4);

	// Scan until -->
	while (!at_end(s)) {
		if (peek(s, 0) === "-" && peek(s, 1) === "-" && peek(s, 2) === ">") {
			advance(s, 3);
			break;
		}
		advance(s);
	}

	push({ type: "comment" as TokenType, range: range_from(s, start) });
	return true;
}

// ---------------------------------------------------------------------------
// <script> / <style> - opaque bodies
// ---------------------------------------------------------------------------

function try_scan_script_style(s: ScanState): boolean {
	const start = s.pos;
	const tag = peek_open_tag_name(s);
	if (tag !== "script" && tag !== "style") return false;

	const token_type: TokenType = tag === "script" ? "script_body" : "style_body";

	// Skip past the opening tag
	const open_end = skip_tag(s);
	if (open_end < 0) return false;

	// Find the closing tag
	const close_tag = `</${tag}`;
	let depth = 1;
	const body_start = s.pos;

	while (!at_end(s)) {
		if (s.source.slice(s.pos, s.pos + close_tag.length).toLowerCase() === close_tag) {
			depth--;
			if (depth === 0) {
				// Skip to end of closing tag
				s.pos += close_tag.length;
				skip_to(s, ">");
				advance(s); // skip >
				break;
			}
		}
		// Check for nested same tag
		const nested = peek_open_tag_name(s);
		if (nested === tag) depth++;
		advance(s);
	}

	if (depth > 0) {
		// Unclosed - recovery: emit what we have
		errors.push({ range: { start, end: s.pos }, message: `Unclosed <${tag}>` });
	}

	push({ type: token_type, range: range_from(s, start) });
	return true;
}

// ---------------------------------------------------------------------------
// <pre> / <textarea> - opaque bodies (no Ree directives inside)
// ---------------------------------------------------------------------------

function try_scan_pre_textarea(s: ScanState): boolean {
	const start = s.pos;
	const tag_lower = peek_open_tag_name(s).toLowerCase();
	if (tag_lower !== "pre" && tag_lower !== "textarea") return false;

	// Skip the opening tag
	const open_end = skip_tag(s);
	if (open_end < 0) return false;

	const close_tag = `</${tag_lower}`;

	while (!at_end(s)) {
		if (s.source.slice(s.pos, s.pos + close_tag.length).toLowerCase() === close_tag) {
			// Skip to end of closing tag
			s.pos += close_tag.length;
			skip_to(s, ">");
			advance(s);
			break;
		}
		advance(s);
	}

	push({ type: tag_lower === "pre" ? "pre_body" as TokenType : "pre_body" as TokenType, range: range_from(s, start) });
	return true;
}

// ---------------------------------------------------------------------------
// Raw JS: {{ ... }}
// ---------------------------------------------------------------------------

function try_scan_raw_js(s: ScanState): boolean {
	if (peek(s, 0) !== "{" || peek(s, 1) !== "{") return false;

	const start = s.pos;
	advance(s, 2);

	// Scan until }} (non-greedy, matching compiler)
	const close_idx = s.source.indexOf("}}", s.pos);
	if (close_idx >= 0) {
		s.pos = close_idx + 2;
	} else {
		// Unclosed - consume to end
		s.pos = s.length;
		errors.push({ range: { start, end: s.pos }, message: "Unterminated {{ ... }} block" });
	}

	push({ type: "raw_js" as TokenType, range: range_from(s, start) });
	return true;
}

// ---------------------------------------------------------------------------
// Ree directives: {...} with prefix characters
// Prefixes: # (block open / include / layout), : (else), / (close), =, ~, _, -, @
// ---------------------------------------------------------------------------

function try_scan_ree_directive(s: ScanState): boolean {
	if (peek(s, 0) !== "{") return false;

	const prefix = peek(s, 1);
	if (!"#:/=~_-@".includes(prefix)) return false;

	// {# and {: and {/ need a non-whitespace next char
	// {= and {~ need whitespace after (as per compiler: prefix char then whitespace)
	if (prefix === "#" || prefix === ":" || prefix === "/") {
		// These are block/close/else - don't require whitespace after prefix
	} else if (prefix === "=" || prefix === "~" || prefix === "_" || prefix === "-" || prefix === "@") {
		if (!is_whitespace(peek(s, 2))) return false;
	}

	return scan_balanced_braces(s);
}

/**
 * Scan a {prefix ...} construct. Uses brace balancing to find the closing }
 * matching the compiler's scan_balanced_tag logic.
 */
function scan_balanced_braces(s: ScanState): boolean {
	const start = s.pos;
	const prefix = peek(s, 1);
	advance(s, 2); // skip {<prefix>

	let depth = 1;
	let in_str: string | null = null;
	let esc = false;

	while (!at_end(s)) {
		const ch = peek(s);
		if (in_str) {
			if (esc) {
				esc = false;
			} else if (ch === "\\") {
				esc = true;
			} else if (ch === in_str) {
				in_str = null;
			}
		} else if (ch === '"' || ch === "'" || ch === "`") {
			in_str = ch;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				advance(s);
				break;
			}
		}
		advance(s);
	}

	if (depth > 0) {
		// Unclosed - recovery
		errors.push({ range: { start, end: s.pos }, message: `Unterminated {${prefix} ... } directive` });
	}

	const content = slice_from(s, start);
	const token = classify_directive(start, range_from(s, start), content, prefix!);
	push(token);
	return true;
}

/**
 * Classify the directive by its prefix and content.
 */
function classify_directive(start: number, range: SourceRange, raw: string, prefix: string): Token {
	// Extract inner content between {<prefix> and }
	// raw looks like: {#if condition } or {= expression }
	const inner_start = 2; // skip "{<prefix>"
	const inner_end = raw.length - 1; // skip trailing "}"
	const inner = raw.slice(inner_start, inner_end).trim();

	if (prefix === "#") {
		// {#if ...}, {#each ...}, {#with ...}, {#include("...")}, {#layout("...")}
		if (inner.startsWith("if") && (inner.length === 2 || is_whitespace(inner[2]!) || inner[2] === "(")) {
			return { type: "block_open" as TokenType, range, block_type: "if" };
		}
		if (inner.startsWith("each ") || inner === "each") {
			return { type: "block_open" as TokenType, range, block_type: "each" };
		}
		if (inner.startsWith("with ") || inner === "with") {
			return { type: "block_open" as TokenType, range, block_type: "with" };
		}
		if (inner.startsWith("include(")) {
			const path = extract_string_arg(inner, "include");
			return { type: "include" as TokenType, range, path_value: path };
		}
		if (inner.startsWith("layout(")) {
			const path = extract_string_arg(inner, "layout");
			return { type: "layout" as TokenType, range, path_value: path };
		}
		// Unknown block directive
		return { type: "error" as TokenType, range, recovery: true };
	}

	if (prefix === ":") {
		return { type: "block_else" as TokenType, range };
	}

	if (prefix === "/") {
		const block_type = inner === "if" ? "if" : inner === "each" ? "each" : inner === "with" ? "with" : undefined;
		return { type: "block_close" as TokenType, range, block_type };
	}

	if (prefix === "_" || prefix === "-" || prefix === "@") {
		return { type: "translation" as TokenType, range, prefix, translation_key: inner };
	}

	if (prefix === "=" || prefix === "~") {
		return { type: "output" as TokenType, range, prefix, expression: inner };
	}

	return { type: "error" as TokenType, range, recovery: true };
}

/** Extract the first string argument from a function-call-like directive. */
function extract_string_arg(inner: string, directive_name: string): string | undefined {
	const open_paren = inner.indexOf("(");
	if (open_paren < 0) return undefined;

	const after_paren = inner.slice(open_paren + 1).trimStart();
	if (after_paren.length < 2) return undefined;

	const quote = after_paren[0];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;

	let i = 1;
	let esc = false;
	while (i < after_paren.length) {
		const ch = after_paren[i];
		if (esc) { esc = false; i++; continue; }
		if (ch === "\\") { esc = true; i++; continue; }
		if (ch === quote) {
			return after_paren.slice(1, i);
		}
		i++;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// HTML tags and ReeTag components
// ---------------------------------------------------------------------------

function try_scan_tag(s: ScanState): boolean {
	if (peek(s, 0) !== "<") return false;

	// Check if this could be a tag: next char must be alpha or "/"
	const c1 = peek(s, 1).toLowerCase();
	if (!is_alpha(c1) && c1 !== "/") return false;

	const start = s.pos;

	// Is it a closing tag?
	if (c1 === "/") {
		return scan_close_tag(s, start);
	}

	return scan_open_tag(s, start);
}

/**
 * Peek at the potential open tag name without consuming.
 */
function peek_open_tag_name(s: ScanState): string {
	if (peek(s, 0) !== "<") return "";
	let i = 1;
	// Skip "!" for doctype/comments
	if (peek(s, 1) === "!") return "";
	let name = "";
	while (is_alphanum(peek(s, i)) || peek(s, i) === "-") {
		name += peek(s, i);
		i++;
	}
	return name.toLowerCase();
}

/**
 * Scan an opening tag: <tagname ...> or <tagname ... />
 */
function scan_open_tag(s: ScanState, start: number): boolean {
	advance(s); // skip "<"

	// Parse tag name
	let name = "";
	while (!at_end(s) && (is_alphanum(peek(s)) || peek(s) === "-")) {
		name += peek(s);
		advance(s);
	}
	name = name.toLowerCase();

	if (!name) {
		// Not a valid tag - backtrack
		s.pos = start;
		return false;
	}

	const is_component = name.includes("-");
	const is_void = is_void_element(name);

	// Parse attributes (until > or /)
	const attr_start = s.pos;
	scan_attributes(s);
	const attr_str = s.source.slice(attr_start, s.pos);

	// Check for self-closing
	let self_closing = false;
	if (peek(s) === "/") {
		self_closing = true;
		advance(s); // skip /
	}

	// Void elements are always self-closing even without />
	if (is_void && !self_closing) {
		// Re-parse: void elements may have inline Ree blocks before >
		// Don't set self_closing flag - use a different approach:
		// Push as tag_self_close so the parser doesn't expect a closing tag
		self_closing = true;
	}

	if (peek(s) === ">") {
		advance(s); // skip >
	} else {
		// Unterminated tag - recovery: consume to next > or line end
		while (!at_end(s) && peek(s) !== ">" && peek(s) !== "\n") advance(s);
		if (peek(s) === ">") advance(s);
		errors.push({ range: { start, end: s.pos }, message: `Unterminated tag <${name}>` });
	}

	const range: SourceRange = { start, end: s.pos };

	if (is_component) {
		if (self_closing) {
			push({ type: "component_self_close" as TokenType, range, tag_name: name, attributes: attr_str, self_closing: true });
		} else {
			push({ type: "component_open" as TokenType, range, tag_name: name, attributes: attr_str });
		}
	} else {
		if (self_closing) {
			push({ type: "tag_self_close" as TokenType, range, tag_name: name, attributes: attr_str, self_closing: true });
		} else {
			push({ type: "tag_open" as TokenType, range, tag_name: name, attributes: attr_str });
		}
	}

	return true;
}

/**
 * Scan a closing tag: </tagname>
 */
function scan_close_tag(s: ScanState, start: number): boolean {
	advance(s, 2); // skip "</"

	let name = "";
	while (!at_end(s) && (is_alphanum(peek(s)) || peek(s) === "-")) {
		name += peek(s);
		advance(s);
	}

	if (peek(s) === ">") {
		advance(s);
	} else {
		// Unterminated - recovery
		errors.push({ range: { start, end: s.pos }, message: `Unterminated closing tag </${name}>` });
	}

	const is_component = name.includes("-");
	push({
		type: is_component ? "component_close" as TokenType : "tag_close" as TokenType,
		range: range_from(s, start),
		tag_name: name.toLowerCase(),
	});

	return true;
}

/**
 * Skip past an opening tag (from "<" through ">").
 * Returns the position after ">" or -1 on failure.
 */
function skip_tag(s: ScanState): number {
	if (peek(s) !== "<") return -1;

	let i = s.pos;
	while (i < s.length && s.source[i] !== ">") {
		const ch = s.source[i];
		// Handle strings inside attributes
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			let esc = false;
			while (i < s.length) {
				if (esc) { esc = false; i++; continue; }
				if (s.source[i] === "\\") { esc = true; i++; continue; }
				if (s.source[i] === quote) break;
				i++;
			}
			if (i < s.length) i++;
		} else if (ch === "{") {
			// Skip past inline Ree directive
			i++;
			let brace_depth = 1;
			let in_str: string | null = null;
			let esc = false;
			while (i < s.length && brace_depth > 0) {
				const c = s.source[i]!;
				if (in_str) {
					if (esc) { esc = false; }
					else if (c === "\\") { esc = true; }
					else if (c === in_str) { in_str = null; }
				} else if (c === '"' || c === "'" || c === "`") {
					in_str = c;
				} else if (c === "{") {
					brace_depth++;
				} else if (c === "}") {
					brace_depth--;
				}
				i++;
			}
		} else {
			i++;
		}
	}
	if (i >= s.length) return -1;
	s.pos = i + 1;
	return s.pos;
}

/**
 * Scan past tag attributes, respecting quoted strings and inline Ree blocks.
 * Stops at > or / (outside of quoted strings and balanced braces).
 */
function scan_attributes(s: ScanState): void {
	while (!at_end(s)) {
		const ch = peek(s);

		if (ch === ">" || ch === "/") break;

		if (ch === '"' || ch === "'") {
			const quote = ch;
			advance(s);
			let esc = false;
			while (!at_end(s)) {
				if (esc) { esc = false; advance(s); continue; }
				if (peek(s) === "\\") { esc = true; advance(s); continue; }
				if (peek(s) === quote) { advance(s); break; }
				advance(s);
			}
		} else if (ch === "{") {
			// Skip past inline Ree directive - track brace depth
			advance(s);
			let brace_depth = 1;
			let in_str: string | null = null;
			let esc = false;
			while (!at_end(s) && brace_depth > 0) {
				const c = peek(s);
				if (in_str) {
					if (esc) { esc = false; }
					else if (c === "\\") { esc = true; }
					else if (c === in_str) { in_str = null; }
				} else if (c === '"' || c === "'" || c === "`") {
					in_str = c;
				} else if (c === "{") {
					brace_depth++;
				} else if (c === "}") {
					brace_depth--;
				}
				advance(s);
			}
		} else {
			advance(s);
		}
	}
}

/**
 * Skip past characters until the target is found.
 */
function skip_to(s: ScanState, target: string): void {
	while (!at_end(s) && peek(s) !== target) advance(s);
}

// ---------------------------------------------------------------------------
// Literal text
// ---------------------------------------------------------------------------

function scan_text(s: ScanState): void {
	const start = s.pos;

	// Consume until we hit a potential token start
	while (!at_end(s)) {
		const ch = peek(s);
		if (ch === "<" || ch === "{") break;
		advance(s);
	}

	// An unrecognized literal "<" or "{" must still advance the scanner.
	// Otherwise the main loop retries the same position forever.
	if (s.pos === start && !at_end(s)) {
		advance(s);
	}

	if (s.pos > start) {
		push({ type: "text" as TokenType, range: range_from(s, start) });
	}
}
