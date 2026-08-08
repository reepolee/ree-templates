/**
 * Structural diagnostics for .ree templates.
 *
 * Converts scanner/parser errors and structural issues into LSP
 * Diagnostic objects. Published on document open and change.
 *
 * Handles:
 * - Scanner-level errors (unterminated braces, strings, tags)
 * - Parser-level errors (mismatched blocks, unclosed elements)
 * - Structural validation (duplicate {:else}, nesting issues)
 */

import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";

import { scan, get_errors } from "../parser/scanner";
import { parse } from "../parser/parser";
import type { SourceRange } from "../parser/ast";
import { offset_to_position } from "../documents/positions";

// ---------------------------------------------------------------------------
// Diagnostic source and codes
// ---------------------------------------------------------------------------

const DIAGNOSTIC_SOURCE = "ree-lsp";

export const DiagnosticCodes = {
	/** Unterminated or unclosed construct */
	UNTERMINATED: "ree.unterminated",
	/** Mismatched block closer (e.g. {/each} closes {#if}) */
	MISMATCHED_BLOCK: "ree.mismatched_block",
	/** Unclosed block, tag, or component */
	UNCLOSED: "ree.unclosed",
	/** Duplicate {:else} in the same block */
	DUPLICATE_ELSE: "ree.duplicate_else",
	/** Malformed directive shape */
	MALFORMED_DIRECTIVE: "ree.malformed_directive",
	/** Unknown translation key */
	UNKNOWN_TRANSLATION: "ree.unknown_translation",
} as const;

// ---------------------------------------------------------------------------
// Main diagnostics entry point
// ---------------------------------------------------------------------------

/**
 * Compute diagnostics for a document text, using proper LSP position
 * conversion based on the actual source text.
 */
export function compute_diagnostics(text: string): Diagnostic[] {
	const tokens = scan(text);
	const scanner_errors = get_errors();
	const { errors: parser_errors } = parse(tokens, scanner_errors);

	const diagnostics: Diagnostic[] = [];

	for (const err of scanner_errors) {
		const code: string = DiagnosticCodes.UNTERMINATED;
		diagnostics.push(error_to_diagnostic(text, err, code));
	}

	for (const err of parser_errors) {
		let code: string = DiagnosticCodes.UNCLOSED;
		if (err.message.includes("Mismatched")) {
			code = DiagnosticCodes.MISMATCHED_BLOCK;
		} else if (err.message.includes("Unclosed")) {
			code = DiagnosticCodes.UNCLOSED;
		} else if (err.message.includes("Unexpected")) {
			code = DiagnosticCodes.MALFORMED_DIRECTIVE;
		}
		diagnostics.push(error_to_diagnostic(text, err, code));
	}

	return deduplicate(diagnostics);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a source-range error into an LSP Diagnostic with proper position
 * conversion from the source text.
 */
function error_to_diagnostic(
	text: string,
	err: { range: SourceRange; message: string },
	code: string,
): Diagnostic {
	return {
		range: {
			start: offset_to_position(text, err.range.start),
			end: offset_to_position(text, err.range.end),
		},
		message: err.message,
		severity: DiagnosticSeverity.Error,
		source: DIAGNOSTIC_SOURCE,
		code,
	};
}

/**
 * Deduplicate overlapping diagnostics. Keeps the first one and drops any
 * that overlap significantly with it.
 */
function deduplicate(diagnostics: Diagnostic[]): Diagnostic[] {
	if (diagnostics.length <= 1) return diagnostics;

	const sorted = [...diagnostics].sort((a, b) =>
		a.range.start.line * 100000 + a.range.start.character
		- (b.range.start.line * 100000 + b.range.start.character),
	);
	const result: Diagnostic[] = [];

	for (const diag of sorted) {
		const overlaps = result.some((kept) => {
			const same_line = kept.range.start.line === diag.range.start.line;
			const close_start = Math.abs(kept.range.start.character - diag.range.start.character) < 5;
			const same_message = kept.message === diag.message;
			return same_line && close_start && same_message;
		});

		if (!overlaps) {
			result.push(diag);
		}
	}

	return result;
}
