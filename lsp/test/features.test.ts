/**
 * Feature tests: diagnostics emitted by the server.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "bun";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function read_message(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown> | null> {
	const decoder = new TextDecoder();
	let buf = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) return null;

		buf += decoder.decode(value, { stream: true });

		const header_match = buf.match(/^Content-Length: (\d+)\r\n\r\n/);
		if (!header_match) continue;

		const content_length = parseInt(header_match[1]!, 10);
		const header_end = header_match[0]!.length;

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

async function drain_notifications(reader: ReadableStreamDefaultReader<Uint8Array>, count: number, timeout_ms = 2000): Promise<Record<string, unknown>[]> {
	const results: Record<string, unknown>[] = [];
	const deadline = Date.now() + timeout_ms;

	while (results.length < count && Date.now() < deadline) {
		const msg = await Promise.race([
			read_message(reader),
			new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
		]);
		if (msg && (msg as any).method) {
			results.push(msg);
		}
	}

	return results;
}

function send_message(stdin: { write(data: Uint8Array): void }, msg: Record<string, unknown>): void {
	const body = JSON.stringify(msg);
	const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
	const encoder = new TextEncoder();
	stdin.write(encoder.encode(header + body));
}

let id_counter = 0;
function next_id(): number {
	return ++id_counter;
}

function spawn_server() {
	const server = spawn({
		cmd: ["bun", "run", "src/server.ts", "--stdio"],
		cwd: import.meta.dir + "/..",
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const reader = (server.stdout as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();

	return {
		server,
		reader,
		read_message: () => read_message(reader),
		drain_notifications: (count: number, timeout_ms?: number) => drain_notifications(reader, count, timeout_ms),
		send_message: (msg: Record<string, unknown>) => send_message(server.stdin, msg),
		kill: () => {
			try { reader.releaseLock(); } catch { /* */ }
			server.kill();
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Diagnostics", () => {
	test("valid template produces no diagnostic errors", async () => {
		const { read_message, send_message, drain_notifications, kill } = spawn_server();

		// Initialize
		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		// Open a valid template
		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: "file:///test/valid.ree",
					languageId: "ree",
					version: 1,
					text: `{#layout('layouts/base') }
<div>
  {#if props.user}
    <h1>{_ ui.title }</h1>{= props.user.name }
  {:else}
    <p>{_ auth.login }</p>
  {/if}
</div>`,
				},
			},
		});

		// Collect diagnostics notification
		const notifications = await drain_notifications(1);
		const diag_notification = notifications.find(n => n.method === "textDocument/publishDiagnostics");
		expect(diag_notification).toBeDefined();

		const params = diag_notification!.params as Record<string, unknown>;
		const diagnostics = params.diagnostics as unknown[];
		expect(diagnostics.length).toBe(0);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		kill();
	});

	test("unclosed block produces diagnostic errors", async () => {
		const { read_message, send_message, drain_notifications, kill } = spawn_server();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: "file:///test/incomplete.ree",
					languageId: "ree",
					version: 1,
					text: `{#if props.user
  <div>{= props.user.name }`,
				},
			},
		});

		const notifications = await drain_notifications(1);
		const diag_notification = notifications.find(n => n.method === "textDocument/publishDiagnostics");
		expect(diag_notification).toBeDefined();

		const params = diag_notification!.params as Record<string, unknown>;
		const diagnostics = params.diagnostics as unknown[];
		expect(diagnostics.length).toBeGreaterThan(0);

		// Verify at least one diagnostic mentions "unterminated" or "unclosed"
		const messages = diagnostics.map((d: any) => (d as any).message).join(" ").toLowerCase();
		expect(messages).toMatch(/unterminated|unclosed/);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		kill();
	});

	test("mismatched block closer produces diagnostic", async () => {
		const { read_message, send_message, drain_notifications, kill } = spawn_server();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: "file:///test/mismatched.ree",
					languageId: "ree",
					version: 1,
					text: `{#if a }{/each}`,
				},
			},
		});

		const notifications = await drain_notifications(1);
		const diag_notification = notifications.find(n => n.method === "textDocument/publishDiagnostics");
		expect(diag_notification).toBeDefined();

		const params = diag_notification!.params as Record<string, unknown>;
		const diagnostics = params.diagnostics as unknown[];
		expect(diagnostics.length).toBeGreaterThan(0);

		const messages = diagnostics.map((d: any) => (d as any).message).join(" ").toLowerCase();
		expect(messages).toMatch(/mismatched/);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		kill();
	});

	test("diagnostics update after document change", async () => {
		const { read_message, send_message, drain_notifications, kill } = spawn_server();

		send_message({ jsonrpc: "2.0", id: next_id(), method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
		await read_message();

		// Open incomplete template - should have errors
		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: "file:///test/dynamic.ree",
					languageId: "ree",
					version: 1,
					text: `{#if a }`,
				},
			},
		});

		const open_notifications = await drain_notifications(1);
		const open_diag = open_notifications.find(n => n.method === "textDocument/publishDiagnostics");
		expect(open_diag).toBeDefined();
		const open_params = open_diag!.params as Record<string, unknown>;
		const open_diagnostics = open_params.diagnostics as unknown[];
		expect(open_diagnostics.length).toBeGreaterThan(0);

		// Now fix the template - should have no errors
		send_message({
			jsonrpc: "2.0",
			method: "textDocument/didChange",
			params: {
				textDocument: {
					uri: "file:///test/dynamic.ree",
					version: 2,
				},
				contentChanges: [{ text: `{#if a }yes{/if}` }],
			},
		});

		// Need to read the next notification from the change
		const change_notifications = await drain_notifications(1);
		const change_diag = change_notifications.find(n => n.method === "textDocument/publishDiagnostics");
		expect(change_diag).toBeDefined();
		const change_params = change_diag!.params as Record<string, unknown>;
		const change_diagnostics = change_params.diagnostics as unknown[];
		expect(change_diagnostics.length).toBe(0);

		send_message({ jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
		await read_message();
		send_message({ jsonrpc: "2.0", method: "exit", params: null });
		kill();
	});
});
