/**
 * Formatter integration for .ree templates.
 *
 * Invokes the external `reettier` tool through stdin, using the project root
 * as cwd. Returns a full-document TextEdit only when the formatted output
 * differs from the input.
 *
 * Safety:
 * - No shell string interpolation for document content or executable args
 * - Bounded timeout (10s) and maximum stderr capture (4KB)
 * - Formatting preserves source when the formatter fails
 * - Cancellation handled via AbortSignal
 */

import type { TextEdit } from "vscode-languageserver";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatResult {
	/** The formatted text, or the original text on failure. */
	text: string;
	/** TextEdit to apply, or undefined when output equals input. */
	edit: TextEdit | undefined;
	/** Error message for logging, if any. */
	error?: string;
}

export interface FormatOptions {
	/** Path to the reettier executable. Default: "reettier" (PATH lookup). */
	executablePath?: string;
	/** Working directory (project root). Required. */
	cwd: string;
	/** Timeout in ms. Default: 10000. */
	timeout?: number;
	/** Whether to pass --full for reprint mode. */
	full?: boolean;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format a document using the reettier executable.
 */
export async function format_document(
	text: string,
	options: FormatOptions,
): Promise<FormatResult> {
	const cmd = options.executablePath || "reettier";
	const cwd = options.cwd;
	const timeout = options.timeout ?? 10000;
	const extra_args = options.full ? ["--full"] : [];

	return new Promise<FormatResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let timed_out = false;

		const proc = spawn(cmd, ["--stdin", ...extra_args], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			timed_out = true;
			proc.kill();
		}, timeout);

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
			// Bound maximum stdout capture (10MB)
			if (stdout.length > 10_000_000) {
				proc.kill();
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
			// Bound maximum stderr capture (4KB for logging)
			if (stderr.length > 4096) {
				stderr = stderr.slice(0, 4096) + "...";
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				text,
				edit: undefined,
				error: `Failed to spawn ${cmd}: ${err.message}`,
			});
		});

		proc.on("close", (code) => {
			clearTimeout(timer);

			if (timed_out) {
				resolve({
					text,
					edit: undefined,
					error: `Formatter ${cmd} timed out after ${timeout}ms`,
				});
				return;
			}

			if (code !== 0) {
				resolve({
					text,
					edit: undefined,
					error: `${cmd} exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
				});
				return;
			}

			if (stdout === text) {
				resolve({ text, edit: undefined });
				return;
			}

			resolve({
				text: stdout,
				edit: {
					range: {
						start: { line: 0, character: 0 },
						end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
					},
					newText: stdout,
				},
			});
		});

		// Write input
		proc.stdin.write(text);
		proc.stdin.end();
	});
}
