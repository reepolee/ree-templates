/**
 * Protocol smoke test for the ree-lsp server.
 *
 * Starts the server as a child process over stdio, sends JSON-RPC
 * initialize / open / shutdown messages, and verifies valid framing.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read one JSON-RPC message from the server's stdout.
 * Uses Bun's Subprocess stdout which is a ReadableStream<Uint8Array>.
 */
async function read_message(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown> | null> {
	const decoder = new TextDecoder();
	let buf = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) return null;

		buf += decoder.decode(value, { stream: true });

		// JSON-RPC header: Content-Length: <number>\r\n\r\n
		const header_match = buf.match(/^Content-Length: (\d+)\r\n\r\n/);
		if (!header_match) continue;

		const content_length = parseInt(header_match[1]!, 10);
		const header_end = header_match[0]!.length;

		// Wait for the full body
		while (buf.length - header_end < content_length) {
			const { done: d, value: v } = await reader.read();
			if (d) return null;
			buf += decoder.decode(v, { stream: true });
		}

		const body = buf.slice(header_end, header_end + content_length);
		try {
			return JSON.parse(body) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}

/**
 * Send a JSON-RPC message to the server's stdin.
 * Bun's Subprocess stdin is a FileSink, so we call .write() directly.
 */
function send_message(stdin: { write(data: Uint8Array): void }, msg: Record<string, unknown>): void {
	const body = JSON.stringify(msg);
	const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
	const encoder = new TextEncoder();
	try {
		stdin.write(encoder.encode(header + body));
	} catch {
		// The server closes stdin once it has handled `shutdown`, so the
		// trailing `exit` notification can race with the pipe closing.
	}
}

let id_counter = 0;
function next_id(): number {
	return ++id_counter;
}

/**
 * Spawn the server as a child process.
 * Returns helpers for reading/writing LSP messages.
 */
function spawn_server(): {
	server: Subprocess<"pipe", "pipe", "pipe">;
	read_message: () => Promise<Record<string, unknown> | null>;
	send_message: (msg: Record<string, unknown>) => void;
	kill: () => Promise<void>;
} {
	const server = spawn({
		cmd: ["bun", "run", "src/server.ts", "--stdio"],
		cwd: import.meta.dir + "/..",
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Bun's Subprocess.stdout is ReadableStream; use any to avoid type mismatch
	// with Bun's extended ReadableStream that requires readMany.
	const reader = (server.stdout as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();

	return {
		server,
		read_message: () => read_message(reader),
		send_message: (msg) => send_message(server.stdin, msg),
		// Await exit so a killed server cannot leak pending stdio writes into
		// the next test, which surfaces as a stray EPIPE.
		kill: async () => {
			try { await reader.cancel(); } catch { /* already closed */ }
			try { reader.releaseLock(); } catch { /* */ }
			server.kill();
			await server.exited;
		},
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ree-lsp protocol smoke test", () => {
	test("initialize returns valid capabilities", async () => {
		const { read_message, send_message, kill } = spawn_server();

		const id = next_id();
		send_message({
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				processId: null,
				rootUri: null,
				capabilities: {},
			},
		});

		const response = await read_message();
		expect(response).not.toBeNull();
		expect(response!.jsonrpc).toBe("2.0");
		expect(response!.id).toBe(id);
		expect(response!.result).toBeDefined();

		const result = response!.result as Record<string, unknown>;
		expect(result.capabilities).toBeDefined();

		const caps = result.capabilities as Record<string, unknown>;
		expect(caps.textDocumentSync).toBe(1); // Full sync

		// Clean shutdown
		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		await kill();
	});

	test("initialized notification is accepted", async () => {
		const { send_message, kill } = spawn_server();

		// Initialize first
		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		// We don't actually need to read the response for this test

		send_message({
			jsonrpc: "2.0",
			method: "initialized",
			params: {},
		});

		// No response expected for notifications - just wait briefly
		await Bun.sleep(200);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		await kill();
	});

	test("didOpen and didChange do not crash", async () => {
		const { read_message, send_message, kill } = spawn_server();

		// Initialize
		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: "file:///test/sample.ree",
					languageId: "ree",
					version: 1,
					text: "<div>Hello</div>\n",
				},
			},
		});

		// No response expected
		await Bun.sleep(100);

		// Send didChange
		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didChange",
			params: {
				textDocument: {
					uri: "file:///test/sample.ree",
					version: 2,
				},
				contentChanges: [
					{ text: "<div>Hello, world!</div>\n" },
				],
			},
		});

		await Bun.sleep(100);

		// Shutdown
		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		await kill();
	});

	test("shutdown returns null", async () => {
		const { read_message, send_message, kill } = spawn_server();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		const id = next_id();
		send_message({
			jsonrpc: "2.0",
			id,
			method: "shutdown",
			params: null,
		});

		const response = await read_message();
		expect(response).not.toBeNull();
		expect(response!.id).toBe(id);
		expect(response!.result).toBeNull();

		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		await kill();
	});

	test("exit notification causes server to terminate", async () => {
		const { server, read_message, send_message } = spawn_server();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });

		// Wait for process to exit
		await server.exited;
		expect(server.exitCode).not.toBeNull();
	});

	test("initialize advertises only implemented capabilities", async () => {
		const { read_message, send_message, kill } = spawn_server();

		send_message({
			jsonrpc: "2.0",
			id: next_id(),
			method: "initialize",
			params: {
				processId: null,
				rootUri: null,
				capabilities: {},
			},
		});

		const response = await read_message();
		expect(response).not.toBeNull();

		const caps = (response!.result as Record<string, unknown>).capabilities as Record<string, unknown>;		// Only textDocumentSync and the newly implemented features should be present
		expect(caps.textDocumentSync).toBe(1);
		expect(caps.completionProvider).toBeDefined();
		expect(caps.hoverProvider).toBe(true);
		expect(caps.definitionProvider).toBe(true);
		expect(caps.documentSymbolProvider).toBe(true);
		expect(caps.foldingRangeProvider).toBeUndefined();
		expect(caps.documentFormattingProvider).toBe(true);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		await kill();
	});
});
