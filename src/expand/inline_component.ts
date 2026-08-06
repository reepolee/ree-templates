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
			unwrap_tag_value(attribute.raw_value)
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
 * be spliced into the component body in place of `props.attributes.X`.
 *
 * A raw value that is itself a single `{= expr }` / `{~ expr }` tag is
 * unwrapped to its inner expression, so e.g. `badge={= is_new ? 'NEW' : '' }`
 * inlines as `is_new ? 'NEW' : ''` rather than the literal text `"{= ... }"`.
 * Anything else (a plain string attribute like `type="red"`) becomes a
 * single-quoted string literal.
 */
function expression_literal_for(raw_value: string): string {
	const trimmed = raw_value.trim();
	const tag_match = trimmed.match(/^\{[=~]\s*([\s\S]*)\}$/);
	if (tag_match) return tag_match[1].trim();

	const escaped = trimmed.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `'${escaped}'`;
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
 * When that whole-tag match falls inside a quoted HTML attribute value
 * (`="{~ needle }"` / `='{~ needle }'`), `attribute_value_replacement` is
 * spliced in instead of `replacement` - the surrounding quotes already
 * delimit the value, so it must not be re-wrapped in a JS string literal.
 */
function replace_reference(
	source: string,
	needle_variants: string[],
	replacement: string,
	attribute_value_replacement?: string
): string {
	let result = source;

	for (const needle of needle_variants) {
		const whole_tag_re = new RegExp(`(=(["']))?\\{[=~]\\s*${escape_regex(needle)}\\s*\\}(\\2)?`, 'g');
		result = result.replace(whole_tag_re, (full_match, quote_prefix, quote_char) => {
			if (quote_prefix && attribute_value_replacement !== undefined) {
				return `=${quote_char}${attribute_value_replacement}${quote_char}`;
			}
			return quote_prefix ? `${quote_prefix}${replacement}${quote_char}` : replacement;
		});
		result = result.split(needle).join(replacement);
	}

	return result;
}

function escape_regex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
