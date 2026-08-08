/**
 * Shared context utilities for feature handlers.
 *
 * Extracted from completion, definition, and hover to avoid duplication.
 */

import type { Position } from "vscode-languageserver";
import { scan } from "./scanner";
import type { Token } from "./ast";

/**
 * Find the token that contains the given byte offset.
 */
export function find_token_at(text: string, offset: number): Token | undefined {
	const tokens = scan(text);
	for (const token of tokens) {
		if (offset >= token.range.start && offset <= token.range.end) {
			return token;
		}
	}
	return undefined;
}

/**
 * Get the word at a given byte offset in the source text.
 * Expands left and right from the cursor to find word boundaries.
 */
export function get_word_at(text: string, offset: number): string | null {
	const word_re = /[A-Za-z_$][\w$]*/;

	// Expand left
	let left = offset;
	while (left > 0) {
		const ch = text[left - 1];
		if (ch && /[A-Za-z_$\w]/.test(ch)) {
			left--;
		} else {
			break;
		}
	}

	// Expand right
	let right = offset;
	while (right < text.length) {
		const ch = text[right];
		if (ch && /[A-Za-z_$\w]/.test(ch)) {
			right++;
		} else {
			break;
		}
	}

	const word = text.slice(left, right);
	return word_re.test(word) ? word : null;
}
