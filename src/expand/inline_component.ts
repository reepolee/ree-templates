import { ParsedAttribute, ParsedReeTag } from './tag_parser';

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
 * `props.children` is replaced by the tag's compiled slot content.
 */
export function inline_component(component_source: string, tag: ParsedReeTag): string {
	let result = component_source;

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
			text_or_template_value_for(attribute.raw_value)
		);
	}

	result = replace_reference(result, ['props.children'], tag.slot_content.trim());

	return result;
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
 */
function replace_reference(
	source: string,
	needle_variants: string[],
	replacement: string,
	attribute_value_replacement?: string,
	text_content_replacement?: string
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
		const bare_replacement = text_content_replacement !== undefined ? text_content_replacement : replacement;
		result = result.split(needle).join(bare_replacement);
	}

	return result;
}

function escape_regex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
