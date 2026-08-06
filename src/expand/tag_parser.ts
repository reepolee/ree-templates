/**
 * Parses a ReeTag custom-element invocation (`<tag-name attr="...">...</tag-name>`)
 * out of raw template text, per the "at least one hyphen" rule documented in
 * REE_TEMPLATES.md under "Component includes".
 */

export interface ParsedAttribute {
	name: string;
	// Raw source text of the attribute value, without surrounding quotes.
	// May itself contain template expressions like {= expr } - those are
	// passed through verbatim, not evaluated here.
	raw_value: string;
}

export interface ParsedReeTag {
	tag_name: string;
	attributes: ParsedAttribute[];
	// Raw slot content between the opening and closing tag. Empty string
	// for self-closing tags.
	slot_content: string;
	// Offsets of the full `<tag-name ...>...</tag-name>` span in the source text.
	start: number;
	end: number;
}

const OPEN_TAG_RE = /<([A-Za-z][\w]*-[\w-]*)\b([^>]*?)(\/)?>/g;

/**
 * Finds the ReeTag whose full span (open tag through matching close tag)
 * contains `offset`. Returns undefined if no such tag exists, or if the tag
 * name has no hyphen (per the ReeTag convention, hyphen-less tags are plain
 * HTML and not component invocations).
 */
export function find_ree_tag_at(source: string, offset: number): ParsedReeTag | undefined {
	OPEN_TAG_RE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = OPEN_TAG_RE.exec(source)) !== null) {
		const tag_name = match[1];
		const attrs_text = match[2];
		const self_closing = Boolean(match[3]);
		const open_start = match.index;
		const open_end = match.index + match[0].length;

		if (self_closing) {
			if (offset < open_start || offset > open_end) continue;
			return {
				tag_name,
				attributes: parse_attributes(attrs_text),
				slot_content: '',
				start: open_start,
				end: open_end,
			};
		}

		const close_index = find_matching_close_tag(source, tag_name, open_end);
		if (close_index === -1) continue;

		const close_tag = `</${tag_name}>`;
		const full_end = close_index + close_tag.length;

		if (offset < open_start || offset > full_end) continue;

		return {
			tag_name,
			attributes: parse_attributes(attrs_text),
			slot_content: source.slice(open_end, close_index),
			start: open_start,
			end: full_end,
		};
	}

	return undefined;
}

/**
 * Finds the index of the `</tag_name>` that closes the tag opened at
 * `search_from`, accounting for same-named nested tags.
 */
function find_matching_close_tag(source: string, tag_name: string, search_from: number): number {
	const open_re = new RegExp(`<${escape_regex(tag_name)}\\b[^>]*?(/)?>`, 'g');
	const close_re = new RegExp(`</${escape_regex(tag_name)}>`, 'g');

	open_re.lastIndex = search_from;
	close_re.lastIndex = search_from;

	let depth = 1;
	let cursor = search_from;

	while (depth > 0) {
		open_re.lastIndex = cursor;
		close_re.lastIndex = cursor;

		const next_open = open_re.exec(source);
		const next_close = close_re.exec(source);

		if (!next_close) return -1;

		const open_is_self_closing = next_open?.[1] !== undefined;
		const open_wins =
			next_open && !open_is_self_closing && next_open.index < next_close.index;

		if (open_wins && next_open) {
			depth += 1;
			cursor = next_open.index + next_open[0].length;
		} else {
			depth -= 1;
			if (depth === 0) return next_close.index;
			cursor = next_close.index + next_close[0].length;
		}
	}

	return -1;
}

function escape_regex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Attribute values are either a quoted string ("red") or an unquoted
// template expression ({= expr }, {~ expr }) per REE_TEMPLATES.md's
// "Component includes" examples (`badge={= is_new ? 'NEW' : '' }`).
const ATTR_RE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[=~][^}]*\}))/g;

function parse_attributes(attrs_text: string): ParsedAttribute[] {
	const attributes: ParsedAttribute[] = [];
	let match: RegExpExecArray | null;
	ATTR_RE.lastIndex = 0;

	while ((match = ATTR_RE.exec(attrs_text)) !== null) {
		const name = match[1];
		const raw_value = match[2] ?? match[3] ?? match[4];
		attributes.push({ name, raw_value });
	}

	return attributes;
}
