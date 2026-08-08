/**
 * Position utilities for converting between LSP Position (line, character)
 * and source offsets.
 *
 * LSP uses UTF-16 code-unit offsets for character positions. This module
 * provides helpers that correctly handle non-ASCII text and multi-line
 * content.
 */

import type { Position, Range } from "vscode-languageserver";

/**
 * Convert an LSP Position (0-based line, 0-based UTF-16 character) into a
 * byte offset within the source string.
 *
 * Lines are delimited by \n. \r\n is treated as one line ending (\r is
 * included in the line, which is how VSCode/LSP specify it).
 */
export function position_to_offset(text: string, pos: Position): number {
	const lines = text.split("\n");
	let offset = 0;

	for (let i = 0; i < pos.line && i < lines.length; i++) {
		// +1 for the \n we stripped
		offset += lines[i]!.length + 1;
	}

	const line_text = lines[pos.line] ?? "";
	// character is UTF-16 code units, so for BMP chars this equals string length
	offset += utf16_offset(line_text, pos.character);

	return offset;
}

/**
 * Convert a byte offset to an LSP Position (0-based line, 0-based UTF-16
 * character).
 */
export function offset_to_position(text: string, offset: number): Position {
	const clamped = Math.max(0, Math.min(offset, text.length));
	const prefix = text.slice(0, clamped);
	const lines = prefix.split("\n");
	const line = lines.length - 1;
	const last_line = lines[line] ?? "";
	const character = utf16_length(last_line);
	return { line, character };
}

/**
 * Returns the number of UTF-16 code units needed to represent the first
 * `target` characters of `s`. This equals `target` for BMP-only text, but
 * is larger when surrogate pairs are present.
 */
export function utf16_offset(s: string, target: number): number {
	let count = 0;
	for (let i = 0; i < s.length && count < target; i++) {
		const code = s.charCodeAt(i);
		// Low surrogate - skip, already counted by the preceding high surrogate
		if (code >= 0xdc00 && code <= 0xdfff) continue;
		// High surrogate → represents 2 UTF-16 code units
		count += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
	}
	return count;
}

/**
 * Count the number of UTF-16 code units in a string.
 */
export function utf16_length(s: string): number {
	let len = 0;
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		// Low surrogate - skip, already counted by the preceding high surrogate
		if (code >= 0xdc00 && code <= 0xdfff) continue;
		// High surrogate → represents 2 UTF-16 code units
		len += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
	}
	return len;
}

/**
 * Build line-start offset lookup table for a source string.
 * Used for fast offset-to-position conversion.
 */
export function build_line_starts(text: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			starts.push(i + 1);
		}
	}
	return starts;
}

/**
 * Convert a byte offset to a line number using the line-start table.
 */
export function offset_to_line(line_starts: number[], offset: number): number {
	let lo = 0;
	let hi = line_starts.length - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const start = line_starts[mid]!;
		if (offset < start) {
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return hi;
}

/**
 * Create an LSP Range from start and end offsets.
 */
export function offset_range(text: string, start: number, end: number): Range {
	return {
		start: offset_to_position(text, start),
		end: offset_to_position(text, end),
	};
}
