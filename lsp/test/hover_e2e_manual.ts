import { spawn } from "bun";
import { readFileSync as read_file_sync } from "fs";
import { join } from "path";
import { pathToFileURL as path_to_file_url } from "url";

const project_root = join(import.meta.dir, "..", "..");
const reepolee_root = join(project_root, "..", "reepolee-dev");
const configured_server_file = process.env.REE_LSP_SERVER_FILE;
const server_file = configured_server_file ?? join(project_root, "src", "server.ts");
let response_buffer = Buffer.alloc(0);

async function read_message(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown> | null> {
	while (true) {
		const header_end = response_buffer.indexOf("\r\n\r\n");
		if (header_end >= 0) {
			const header_buffer = response_buffer.subarray(0, header_end);
			const header = header_buffer.toString("ascii");
			const length_match = header.match(/^Content-Length: (\d+)$/m);
			if (!length_match) return null;

			const content_length = Number.parseInt(length_match[1]!, 10);
			const body_start = header_end + 4;
			const message_end = body_start + content_length;
			if (response_buffer.length >= message_end) {
				const body_buffer = response_buffer.subarray(body_start, message_end);
				response_buffer = response_buffer.subarray(message_end);
				const body = body_buffer.toString("utf-8");
				try { return JSON.parse(body) as Record<string, unknown>; }
				catch { return null; }
			}
		}

		const chunk = await reader.read();
		if (chunk.done) return null;
		const next_buffer = Buffer.from(chunk.value);
		response_buffer = Buffer.concat([response_buffer, next_buffer]);
	}
}

function send_message(stdin: { write(data: Uint8Array): void }, message: Record<string, unknown>) {
	const body = JSON.stringify(message);
	const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
	const encoder = new TextEncoder();
	const payload = encoder.encode(header + body);
	stdin.write(payload);
}

let id = 0;
function next_id() { return ++id; }

const server = spawn({
	cmd: ["bun", server_file, "--stdio"],
	cwd: project_root,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const reader = (server.stdout as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();

try {
	// 1. Initialize
	send_message(server.stdin, { jsonrpc: "2.0", id: next_id(), method: "initialize", params: {
		processId: null,
		rootUri: path_to_file_url(reepolee_root).href,
		capabilities: {},
	} });
	const init = await read_message(reader);
	if (!init?.result) throw new Error("Initialize failed");
	console.log("1. Initialize: OK");

	send_message(server.stdin, { jsonrpc: "2.0", method: "initialized", params: {} });

	// 2. Open file
	const text = read_file_sync(join(reepolee_root, "routes_reeman/db_tables/detail.ree"), "utf-8");
	const template_file = join(reepolee_root, "routes_reeman", "db_tables", "detail.ree");
	const uri = path_to_file_url(template_file).href;

	send_message(server.stdin, { jsonrpc: "2.0", method: "textDocument/didOpen", params: {
		textDocument: { uri, languageId: "ree", version: 1, text },
	} });

	const diag = await read_message(reader);
	console.log("2. Diagnostics:", diag?.method === "textDocument/publishDiagnostics" ? "received" : "other");

	// 3. Hover
	const source_lines = text.split("\n");
	const hover_line = source_lines.findIndex((line) => line.includes("labels.row_count"));
	const hover_character = source_lines[hover_line]!.indexOf("labels.row_count") + 2;
	send_message(server.stdin, { jsonrpc: "2.0", id: next_id(), method: "textDocument/hover", params: {
		textDocument: { uri },
		position: { line: hover_line, character: hover_character },
	} });

	const hover = await read_message(reader);
	if (!hover?.result) throw new Error("Hover returned no result");

	const hover_result = hover.result as { contents?: { value?: string } };
	const content = hover_result.contents?.value ?? "";
	const has_row_count = content.includes("Row count");
	const has_sl_si = content.includes("SL-SI") || content.includes("sl-SI");
	const has_en_us = content.includes("EN-US") || content.includes("en-US");
	const key_not_found = content.includes("key not found");

	console.log("3. Hover:");
	console.log("   Row count present:", has_row_count);
	console.log("   sl-SI present:", has_sl_si);
	console.log("   en-US present:", has_en_us);
	console.log("   key not found:", key_not_found);

	if (has_row_count && has_sl_si && has_en_us && !key_not_found) {
		console.log("\n✅ E2E PASS: Multi-locale translation values over the wire");
	} else {
		console.log("\n❌ E2E FAIL");
		console.log("Content:", content.slice(0, 500));
	}

	// Shutdown
	send_message(server.stdin, { jsonrpc: "2.0", id: next_id(), method: "shutdown", params: null });
	await read_message(reader);
	send_message(server.stdin, { jsonrpc: "2.0", method: "exit", params: null });
} finally {
	try { reader.releaseLock(); } catch {}
	server.kill();
}
