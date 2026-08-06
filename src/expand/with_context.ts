/**
 * Handles components whose body is wrapped in `{#with props.attributes}` - the
 * preferred style, since the wrapper names the props the component expects
 * right at the top:
 *
 * ```ree
 * {#with props.attributes}
 *   <label for="{= name }">{= label }</label>
 *   <input value="{~ value || '#000000' }" />
 * {/with}
 * ```
 *
 * The wrapper compiles to a native JS `with` statement, so inside the block a
 * bare `name` and an explicit `props.attributes.name` are the same reference.
 * Expansion supports both: this module substitutes the bare form in place,
 * leaving the dotted form to the caller's normal substitution pass. The
 * wrapper itself is then dropped, since the expanded fragment lands in a page
 * where no `props` object exists.
 *
 * Only identifiers naming an attribute the call site actually passes are
 * substituted. Anything else resolves past the with-context to data the
 * expansion knows nothing about, and is left untouched.
 */

const WITH_ATTRIBUTES_RE = /^[ \t]*\{#with\s+props\.attributes\s*\}[ \t]*\r?\n?|\{#with\s+props\.attributes\s*\}/;

export interface WithSubstitution {
	// Value spliced into a `{= }` / `{~ }` body, where a plain string needs to
	// become a quoted literal to stay a valid JS expression.
	expression_value: string;
	// Value spliced into text content and string interpolation, where the raw
	// text is what belongs.
	text_value: string;
	// Whether splicing this value into a larger expression should be flagged
	// for review - true for frozen string literals, which turn the rest of the
	// expression into dead code.
	flag_partial_splices: boolean;
}

/**
 * Substitutes call-site values for bare references inside every
 * `{#with props.attributes}` block, then unwraps those blocks. Returns the
 * source unchanged when it contains none.
 */
export function expand_with_attributes(
	component_source: string,
	substitutions: Map<string, WithSubstitution>,
	mark_partial_splice: (line: string) => string
): string {
	let result = component_source;

	while (true) {
		const block = find_with_attributes_block(result);
		if (!block) break;

		const substituted = substitute_bare_references(block.body, substitutions, mark_partial_splice);
		const unwrapped = dedent_block(strip_blank_edges(substituted));
		result = result.slice(0, block.start) + unwrapped + result.slice(block.end);
	}

	return result;
}

interface WithBlock {
	// Span of the whole block including both delimiters.
	start: number;
	end: number;
	body: string;
}

function find_with_attributes_block(source: string): WithBlock | undefined {
	const open_match = source.match(WITH_ATTRIBUTES_RE);
	if (!open_match || open_match.index === undefined) return undefined;

	const body_start = open_match.index + open_match[0].length;
	const close = find_matching_close(source, body_start, /\{#with\b/g, /\{\/with\}/g);
	if (!close) return undefined;

	return {
		start: open_match.index,
		end: close.end,
		body: source.slice(body_start, close.start),
	};
}

/**
 * Substitutes bare identifiers naming a passed attribute with the call-site
 * value, within template expression tags only.
 *
 * Skipped, because their bare identifiers do not resolve to `props.attributes`:
 *  - bodies of a nested `{#with expr}`, which layers another object in front
 *    of the scope chain - whether a given name resolves to it or falls through
 *    depends on that object's runtime shape
 *  - spans where a nested `{#each ... as x}` binds a colliding name
 *  - dotted paths and string contents, matched as whole tokens
 *  - helper calls, which are functions rather than data
 */
function substitute_bare_references(
	body: string,
	substitutions: Map<string, WithSubstitution>,
	mark_partial_splice: (line: string) => string
): string {
	if (substitutions.size === 0) return body;

	const names = Array.from(substitutions.keys());
	const skipped_ranges = [...find_nested_with_ranges(body), ...find_each_binding_ranges(body, names)];
	const tag_re = /\{([=~])\s*([\s\S]*?)\}/g;
	const rewrites: Array<{ start: number; end: number; text: string; flagged: boolean }> = [];
	let match: RegExpExecArray | null;

	while ((match = tag_re.exec(body)) !== null) {
		const tag_start = match.index;
		if (is_within_ranges(tag_start, skipped_ranges)) continue;

		const expression = match[2];
		const expression_start = tag_start + match[0].indexOf(expression);
		const substituted = substitute_expression(expression, substitutions, names);
		if (!substituted) continue;

		// A whole-tag reference collapses the tag away, so the value lands in
		// text or attribute position and takes the raw form.
		const is_whole_tag = substituted.replaced_all;
		const text = is_whole_tag
			? substituted.text_only
			: `{${match[1]} ${substituted.expression} }`;
		rewrites.push({
			start: tag_start,
			end: tag_start + match[0].length,
			text,
			flagged: !is_whole_tag && substituted.flagged,
		});
	}

	let result = body;
	for (let i = rewrites.length - 1; i >= 0; i--) {
		const rewrite = rewrites[i];
		result = result.slice(0, rewrite.start) + rewrite.text + result.slice(rewrite.end);
		if (!rewrite.flagged) continue;

		const line_end = end_of_line_at(result, rewrite.start);
		const line_start = start_of_line_at(result, rewrite.start);
		const line = result.slice(line_start, line_end);
		result = result.slice(0, line_start) + mark_partial_splice(line) + result.slice(line_end);
	}

	return result;
}

// Identifiers, dotted paths and quoted strings. Matching paths and strings as
// whole units keeps their internals off limits: `record.label` resolves
// outside the with-context and `'label'` is text, so neither may be touched.
const EXPRESSION_TOKEN_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g;

interface ExpressionSubstitution {
	expression: string;
	// The value in raw form, valid only when the expression was a lone reference.
	text_only: string;
	// Whether the expression was nothing but the reference itself.
	replaced_all: boolean;
	flagged: boolean;
}

function substitute_expression(
	expression: string,
	substitutions: Map<string, WithSubstitution>,
	names: string[]
): ExpressionSubstitution | undefined {
	const rewrites: Array<{ start: number; end: number; text: string }> = [];
	let flagged = false;
	let text_only = '';
	let match: RegExpExecArray | null;
	EXPRESSION_TOKEN_RE.lastIndex = 0;

	while ((match = EXPRESSION_TOKEN_RE.exec(expression)) !== null) {
		const token = match[0];
		if (!names.includes(token)) continue;

		const rest = expression.slice(match.index + token.length);
		if (/^\s*\(/.test(rest)) continue;

		const substitution = substitutions.get(token)!;
		rewrites.push({
			start: match.index,
			end: match.index + token.length,
			text: substitution.expression_value,
		});
		text_only = substitution.text_value;
		if (substitution.flag_partial_splices) flagged = true;
	}

	if (rewrites.length === 0) return undefined;

	const only_rewrite = rewrites.length === 1 ? rewrites[0] : undefined;
	const replaced_all =
		only_rewrite !== undefined &&
		expression.slice(0, only_rewrite.start).trim() === '' &&
		expression.slice(only_rewrite.end).trim() === '';

	let result = expression;
	for (let i = rewrites.length - 1; i >= 0; i--) {
		const rewrite = rewrites[i];
		result = result.slice(0, rewrite.start) + rewrite.text + result.slice(rewrite.end);
	}

	return {
		expression: result.trim(),
		text_only,
		replaced_all,
		flagged: flagged && !replaced_all,
	};
}

interface Range {
	start: number;
	end: number;
}

/**
 * Spans covered by a `{#with expr}` nested inside the block being expanded.
 */
function find_nested_with_ranges(body: string): Range[] {
	const ranges: Range[] = [];
	const open_re = /\{#with\b[^}]*\}/g;
	let match: RegExpExecArray | null;

	while ((match = open_re.exec(body)) !== null) {
		const body_start = match.index + match[0].length;
		const close = find_matching_close(body, body_start, /\{#with\b/g, /\{\/with\}/g);
		const end = close ? close.end : body.length;
		ranges.push({ start: match.index, end });
		open_re.lastIndex = end;
	}

	return ranges;
}

/**
 * Spans where a nested `{#each ... as item, index, key}` binds a name that
 * collides with a call-site attribute, shadowing it for that block.
 */
function find_each_binding_ranges(body: string, names: string[]): Range[] {
	const ranges: Range[] = [];
	const each_re = /\{#each\s+[\s\S]*?\bas\b([^}]*)\}/g;
	let match: RegExpExecArray | null;

	while ((match = each_re.exec(body)) !== null) {
		const bindings = match[1].split(',').map(binding => binding.trim());
		const collides = bindings.some(binding => names.includes(binding));
		if (!collides) continue;

		const body_start = match.index + match[0].length;
		const close = find_matching_close(body, body_start, /\{#each\b/g, /\{\/each\}/g);
		const end = close ? close.start : body.length;
		ranges.push({ start: body_start, end });
	}

	return ranges;
}

/**
 * Finds the closing delimiter matching a block whose body starts at
 * `body_start`, counting nested openers of the same kind.
 */
function find_matching_close(
	source: string,
	body_start: number,
	open_pattern: RegExp,
	close_pattern: RegExp
): { start: number; end: number } | undefined {
	const combined = new RegExp(`${open_pattern.source}|${close_pattern.source}`, 'g');
	combined.lastIndex = body_start;

	let depth = 1;
	let match: RegExpExecArray | null;

	while ((match = combined.exec(source)) !== null) {
		const is_close = match[0].startsWith('{/');
		if (!is_close) {
			depth += 1;
			continue;
		}

		depth -= 1;
		if (depth > 0) continue;

		// Consume trailing spaces but leave the newline, so a following
		// sibling block still starts on its own line.
		const trailing = source.slice(match.index + match[0].length).match(/^[ \t]*/);
		const trailing_length = trailing ? trailing[0].length : 0;
		return { start: match.index, end: match.index + match[0].length + trailing_length };
	}

	return undefined;
}

function is_within_ranges(position: number, ranges: Range[]): boolean {
	const covering = ranges.find(range => position >= range.start && position < range.end);
	return covering !== undefined;
}

/**
 * Removes one level of indentation, so an unwrapped block sits where its
 * `{#with}` line used to.
 */
function dedent_block(block: string): string {
	const lines = block.split('\n');
	const indents = lines
		.filter(line => line.trim().length > 0)
		.map(line => line.match(/^[ \t]*/)?.[0].length ?? 0);
	if (indents.length === 0) return block;

	const common_indent = Math.min(...indents);
	if (common_indent === 0) return block;

	const dedented = lines.map(line => (line.trim().length === 0 ? line : line.slice(common_indent)));
	return dedented.join('\n');
}

function strip_blank_edges(block: string): string {
	return block.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function start_of_line_at(source: string, offset: number): number {
	const newline_at = source.lastIndexOf('\n', offset);
	return newline_at === -1 ? 0 : newline_at + 1;
}

function end_of_line_at(source: string, offset: number): number {
	const newline_at = source.indexOf('\n', offset);
	return newline_at === -1 ? source.length : newline_at;
}
