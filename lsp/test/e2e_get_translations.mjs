import { spawn } from "bun";
import { join } from "node:path";

const server = spawn({
	cmd: ["bun", join(import.meta.dir, "..", "dist", "ree-lsp.cjs"), "--stdio"],
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const reader = (server.stdout).getReader();
let buf = "";
let id = 0;

async function read_msg() {
	const decoder = new TextDecoder();
	while (true) {
		const m = buf.match(/^Content-Length: (\d+)\r\n\r\n/);
		if (m) {
			const len = parseInt(m[1], 10);
			const hdr = m[0].length;
			while (buf.length - hdr < len) {
				const { done, value } = await reader.read();
				if (done) return null;
				buf += decoder.decode(value, { stream: true });
			}
			const body = buf.slice(hdr, hdr + len);
			buf = buf.slice(hdr + len);
			return JSON.parse(body);
		}
		const { done, value } = await reader.read();
		if (done) return null;
		buf += decoder.decode(value, { stream: true });
	}
}

function send(msg) {
	const body = JSON.stringify(msg);
	server.stdin.write(new TextEncoder().encode(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
}

const uri = "file:///" + join("C:/Users/ales/code/labs/iot-ios-celje/apps/main/home/home.ree").replace(/\\/g, "/");

send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
await read_msg();
send({ jsonrpc: "2.0", method: "initialized", params: {} });

send({ jsonrpc: "2.0", id: ++id, method: "ree/getTranslations", params: { textDocument: { uri } } });

let resp = null;
while (true) {
	const msg = await read_msg();
	if (!msg) break;
	if (msg.id === id) { resp = msg; break; }
}

const result = resp?.result;
if (!result) {
	console.log("RESPONSE:", JSON.stringify(resp, null, 2));
} else {
	console.log("locale keys:", Object.keys(result));
	console.log("en-us outside_temperature.label:", result["en-us"]?.["outside_temperature.label"]);
	console.log("sl-si outside_temperature.label:", result["sl-si"]?.["outside_temperature.label"]);
}

server.kill();
