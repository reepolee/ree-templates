import { ParsedAttribute, ParsedReeTag } from './tag_parser';
import { expand_with_attributes, WithSubstitution } from './with_context';

/**
 * Rewrites a component's source so it no longer depends on `props.attributes`
 * / `props.children`, substituting in the literal values or expressions
 * passed at a specific ReeTag call site. The result is meant to replace the
 * call site inline, so a developer can extend it beyond what the shared
 * component allows.
 *
 * Attribute values are inlined two ways depending on where the reference sits
 * in the component source:
 *  - Inside a quoted HTML attribute value (e.g. `value="{~ props.attributes.foo }"`),
 *    the tag is collapsed and replaced with the call-site's raw text as-is -
 *    no extra quoting, since the surrounding `"..."` already delimits it.
 *  - Everywhere else (a bare JS-expression position, e.g.
 *    `class={= props.attributes.type }`), the reference is replaced by the
 *    call-site's raw value re-wrapped so a quoted HTML attribute value (e.g.
 *    `type="red"`) becomes a string literal (`'red'`) and a `{= expr }` value
 *    is spliced in as-is.
 *
 * Components written in the preferred `{#with props.attributes}` style refer
 * to their props as bare names (`{= label }`), so those blocks are expanded
 * first - see `expand_with_attributes`.
 *
 * `props.children` is replaced by the tag's compiled slot content.
 */
export function inline_component(component_source: string, tag: ParsedReeTag): string {
	let result = expand_with_attributes(
		component_source,
		with_substitutions_for(tag),
		mark_partial_splice
	);

	for (const attribute of tag.attributes) {
		const attr_path_variants = [
			`props.attributes.${attribute.name}`,
			`props.attributes["${attribute.name}"]`,
			`props.attributes['${attribute.name}']`,
		];
		result = replace_reference(
			result,
			attr_path_variants,
			expression_literal_for(attribute.raw_value),
			unwrap_tag_value(attribute.raw_value),
			text_or_template_value_for(attribute.raw_value),
			is_plain_string_value(attribute.raw_value)
		);
	}

	result = replace_reference(result, ['props.children'], tag.slot_content.trim());

	return result;
}

/**
 * Builds the per-attribute values used to substitute bare references inside a
 * `{#with props.attributes}` block, from the same helpers the dotted-path
 * substitution uses - so a component expands identically in either style.
 */
function with_substitutions_for(tag: ParsedReeTag): Map<string, WithSubstitution> {
	const substitutions = new Map<string, WithSubstitution>();

	for (const attribute of tag.attributes) {
		substitutions.set(attribute.name, {
			expression_value: expression_literal_for(attribute.raw_value),
			text_value: unwrap_tag_value(attribute.raw_value),
			flag_partial_splices: is_plain_string_value(attribute.raw_value),
		});
	}

	return substitutions;
}

/**
 * Appends the review marker to a line holding a partial splice.
 */
function mark_partial_splice(line: string): string {
	return `${line}${TODO_MARKER}`;
}

/**
 * Unwraps a raw attribute value that is itself a single `{= expr }` /
 * `{~ expr }` tag to its inner expression text (e.g. `{~ record.iso_date }`
 * becomes `record.iso_date`). Used when splicing into a quoted HTML
 * attribute value, where the result should read like a normal template
 * expression tag, not a quoted string literal. Falls back to the raw text
 * unchanged for plain string values.
 */
function unwrap_tag_value(raw_value: string): string {
	const trimmed = raw_value.trim();
	const tag_match = trimmed.match(/^\{([=~])\s*([\s\S]*)\}$/);
	if (tag_match) return `{${tag_match[1]} ${tag_match[2].trim()} }`;

	return trimmed;
}

/**
 * Converts an attribute's raw source text into the expression that should
 * be spliced into a bare JS expression context (e.g. `class={= ... }`).
 *
 * A raw value that is itself a single `{= expr }` / `{~ expr }` tag is
 * unwrapped to its inner expression, so e.g. `badge={= is_new ? 'NEW' : '' }`
 * inlines as `is_new ? 'NEW' : ''` rather than the literal text `"{= ... }"`.
 * Anything else (a plain string attribute like `type="red"`) becomes a
 * single-quoted string literal, since bare JS contexts need proper string literals.
 */
function expression_literal_for(raw_value: string): string {
	const trimmed = raw_value.trim();
	const tag_match = trimmed.match(/^\{[=~]\s*([\s\S]*)\}$/);
	if (tag_match) return tag_match[1].trim();

	const escaped = trimmed.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `'${escaped}'`;
}

/**
 * Converts an attribute's raw source text into a form suitable for splicing
 * into text content or string interpolation contexts (outside HTML attributes).
 *
 * Plain strings are returned as-is (unquoted), while template expressions are
 * preserved as-is. This handles both text nodes and contexts like `id="error-{expr}"`.
 *
 * Note: Complex `{~}` expressions with fallbacks (e.g. `{~ value || fallback }`)
 * cannot be statically evaluated without running the template compiler, so they
 * may need manual cleanup after inlining.
 */
function text_or_template_value_for(raw_value: string): string {
	const trimmed = raw_value.trim();
	const tag_match = trimmed.match(/^\{[=~]\s*([\s\S]*)\}$/);
	if (tag_match) return tag_match[1].trim();

	return trimmed;
}

/**
 * Reports whether a call-site value is a plain string (`value="#ff0000"`)
 * rather than a template expression (`value={= record.color }`). Plain strings
 * are the case where splicing into a larger expression is suspect: the
 * component author wrote the surrounding expression expecting a variable, and
 * a frozen literal usually makes the rest of it (a `|| fallback`, a ternary)
 * dead code that only the developer can resolve.
 */
function is_plain_string_value(raw_value: string): boolean {
	const trimmed = raw_value.trim();
	return !/^\{[=~]\s*[\s\S]*\}$/.test(trimmed);
}

/**
 * Replaces every occurrence of any of `needle_variants` in `source` with
 * `replacement`. When a needle is the entire body of a `{= ... }` / `{~ ... }`
 * tag (the common case: `{= props.children }`, `{= props.attributes.foo }`),
 * the surrounding tag is collapsed away too rather than nesting a new tag
 * inside it - this matters because `replacement` may itself already be a
 * full `{= expr }` tag (e.g. slot content authored as `{= product.name }`),
 * and `{= {= product.name } }` is not valid Ree syntax.
 *
 * Context-aware replacements:
 *  - `attribute_value_replacement`: For quoted HTML attributes (`="value"` or `value="{~ expr }"`)
 *  - `text_content_replacement`: For bare text/string contexts (text nodes and string interpolation)
 *  - `replacement`: For bare JS expressions (`class={= expr }`)
 *
 * `flag_partial_splices` marks partial splices (where the reference is only
 * part of a larger expression) with a TODO comment - see
 * `replace_partial_references`.
 */
function replace_reference(
	source: string,
	needle_variants: string[],
	replacement: string,
	attribute_value_replacement?: string,
	text_content_replacement?: string,
	flag_partial_splices?: boolean
): string {
	let result = source;

	for (const needle of needle_variants) {
		const whole_tag_re = new RegExp(`(=(["']))?\\{[=~]\\s*${escape_regex(needle)}\\s*\\}(\\2)?`, 'g');
		const indices: Array<{ start: number; end: number; match: RegExpExecArray }> = [];
		let match: RegExpExecArray | null;
		while ((match = whole_tag_re.exec(result)) !== null) {
			indices.push({ start: match.index, end: match.index + match[0].length, match });
		}
		for (let i = indices.length - 1; i >= 0; i--) {
			const index_info = indices[i];
			const match_obj = index_info.match;
			const eq_and_quote = match_obj[1];
			const quote_char = match_obj[2];
			let replacement_text: string;
			if (eq_and_quote && attribute_value_replacement !== undefined) {
				replacement_text = `${eq_and_quote}${attribute_value_replacement}${quote_char}`;
			} else if (eq_and_quote) {
				replacement_text = `${eq_and_quote}${replacement}${quote_char}`;
			} else {
				const is_bare_attribute = index_info.start > 0 && result[index_info.start - 1] === '=';
				replacement_text = is_bare_attribute ? replacement : (text_content_replacement ?? replacement);
			}
			result = result.slice(0, index_info.start) + replacement_text + result.slice(index_info.end);
		}
		result = replace_partial_references(
			result,
			needle,
			replacement,
			text_content_replacement,
			flag_partial_splices
		);
	}

	return result;
}

/**
 * Handles references that are only part of a larger expression, e.g.
 * `value="{~ props.attributes.value || '#000000' }"`. The surrounding tag
 * cannot be collapsed, so the reference is spliced in place: inside a
 * `{= ... }` / `{~ ... }` body that is a JS expression position, so a plain
 * string value must be spliced as a string literal. Outside a tag it is plain
 * text interpolation and the raw value is used.
 *
 * When the spliced value is a frozen string literal the rest of the expression
 * (`|| '#000000'`) becomes dead code the expansion cannot resolve on the
 * developer's behalf, so `flag_splices` marks those lines with a TODO. A
 * spliced expression needs no such flag - the result is still live template
 * code that behaves exactly as it did before inlining.
 */
function replace_partial_references(
	source: string,
	needle: string,
	expression_replacement: string,
	text_replacement?: string,
	flag_splices?: boolean
): string {
	let result = source;
	let search_from = 0;

	while (true) {
		const found_at = result.indexOf(needle, search_from);
		if (found_at === -1) break;

		const inside_tag = is_inside_expression_tag(result, found_at);
		const replacement_text = inside_tag ? expression_replacement : (text_replacement ?? expression_replacement);
		result = result.slice(0, found_at) + replacement_text + result.slice(found_at + needle.length);
		search_from = found_at + replacement_text.length;

		if (!flag_splices || !inside_tag) continue;

		const line_end = end_of_line_at(result, search_from);
		result = result.slice(0, line_end) + TODO_MARKER + result.slice(line_end);
		search_from = line_end + TODO_MARKER.length;
	}

	return result;
}

const TODO_MARKER = ' <!-- TODO: expression needs manual review, the surrounding template could not be evaluated -->';

/**
 * Reports whether `offset` sits inside a `{= ... }` / `{~ ... }` tag body,
 * by scanning back for the nearest unclosed tag opener.
 */
function is_inside_expression_tag(source: string, offset: number): boolean {
	const before = source.slice(0, offset);
	const open_at = Math.max(before.lastIndexOf('{='), before.lastIndexOf('{~'));
	if (open_at === -1) return false;

	const close_at = before.indexOf('}', open_at);
	return close_at === -1;
}

function end_of_line_at(source: string, offset: number): number {
	const newline_at = source.indexOf('\n', offset);
	return newline_at === -1 ? source.length : newline_at;
}

function escape_regex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
