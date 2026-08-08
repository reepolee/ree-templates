/**
 * End-to-end LSP integration tests against a real reepolee-dev .ree file.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { readFileSync } from "fs";

const CWD = import.meta.dir + "/..";
const TEST_FILE = "../../reepolee-dev/routes_reeman/db_tables/detail.ree";

let server: Subprocess<"pipe", "pipe", "pipe">;
let reader: ReadableStreamDefaultReader<Uint8Array>;
let stdin: { write(d: Uint8Array): void };
let doc: string;
let id = 0;

async function read_msg(): Promise<Record<string, unknown> | null> {
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return null;
		buf += decoder.decode(value, { stream: true });
		const m = buf.match(/^Content-Length: (\d+)\r\n\r\n/);
		if (!m) continue;
		const len = parseInt(m[1]!, 10);
		const hdr = m[0]!.length;
		while (buf.length - hdr < len) {
			const { done: d, value: v } = await reader.read();
			if (d) return null;
			buf += decoder.decode(v, { stream: true });
		}
		try { return JSON.parse(buf.slice(hdr, hdr + len)) as Record<string, unknown>; }
		catch { return null; }
	}
}

function send(msg: Record<string, unknown>): void {
	const body = JSON.stringify(msg);
	stdin.write(new TextEncoder().encode(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
}

beforeAll(async () => {
	doc = readFileSync(TEST_FILE, "utf-8");
	server = spawn({
		cmd: ["bun", "run", "src/server.ts", "--stdio"],
		cwd: CWD,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	reader = (server.stdout as any).getReader();
	stdin = server.stdin;

	send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
	await read_msg();
	send({ jsonrpc: "2.0", method: "initialized", params: {} });
	send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///test/detail.ree", languageId: "ree", version: 1, text: doc } } });
});

afterAll(() => {
	try { reader.releaseLock(); } catch { /* */ }
	server.kill();
});

describe("ree-lsp e2e against reepolee-dev template", () => {
	test("zero diagnostics on valid production template", async () => {
		let diagnostics: any[] = [];
		while (true) {
			const msg = await read_msg();
			if (msg?.method === "textDocument/publishDiagnostics") {
				diagnostics = (msg.params as any)?.diagnostics ?? [];
				break;
			}
		}
		const errors = diagnostics.filter((d: any) => d.severity === 1);
		console.log(`  ${diagnostics.length} diagnostics, ${errors.length} errors`);
		expect(errors.length).toBe(0);
	});

	test("completions return helpers inside {= ... }", async () => {
		send({ jsonrpc: "2.0", id: ++id, method: "textDocument/completion", params: { textDocument: { uri: "file:///test/detail.ree" }, position: { line: 5, character: 27 } } });

		const resp = await read_msg();
		const items = (resp?.result as any[]) ?? [];
		console.log(`  ${items.length} completion items ✓`);
		expect(items.length).toBeGreaterThan(5);
		expect(items.some((i: any) => i.label === "url")).toBe(true);
	});

	test("document symbols include layout and block structures", async () => {
		send({ jsonrpc: "2.0", id: ++id, method: "textDocument/documentSymbol", params: { textDocument: { uri: "file:///test/detail.ree" } } });

		const resp = await read_msg();
		const symbols = (resp?.result as any[]) ?? [];
		console.log(`  ${symbols.length} symbols: ${symbols.map((s: any) => s.name).join(", ")}`);
		expect(symbols.length).toBe(2);
	});
});
