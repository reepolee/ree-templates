/**
 * LSP client integration for .ree templates.
 *
 * Launches the `ree-lsp` language server via a configurable command
 * and connects it to VS Code through the LanguageClient API.
 *
 * Migration matrix (existing VS Code providers → LSP):
 * -------------------------------------------------------------
 * | Feature              | Before                  | After     |
 * |----------------------|-------------------------|-----------|
 * | Formatter            | extension.ts provider   | LSP       |
 * | Block/helper compl.  | extension.ts provider   | LSP       |
 * | Translation hover    | i18n/hover.ts           | LSP       |
 * | Translation compl.   | i18n/completion.ts      | LSP       |
 * | Translation def.     | i18n/definition.ts      | LSP       |
 * | Translation diag.    | i18n/diagnostics.ts     | LSP       |
 * | Code actions         | i18n/diagnostics.ts     | LSP       |
 * | Rename               | i18n/rename.ts          | LSP       |
 * | Symbols / folding    | N/A (new)               | LSP       |
 * |----------------------|-------------------------|-----------|
 * | Inline decorations   | i18n/inline.ts          | CLIENT    |
 * | Status bar           | i18n/statusBar.ts       | CLIENT    |
 * -------------------------------------------------------------
 *
 * The two client-side features (inline decorations, status bar) use
 * VS Code-specific APIs (TextEditorDecorationType, StatusBarItem)
 * that have no equivalent in the LSP protocol.
 */

import * as vscode from "vscode";
import * as path from "path";
import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
} from "vscode-languageclient/node";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const client_id = "ree-lsp";
const client_name = "ree Language Server";
const language_id = "ree";

// Fallback channel for diagnostics when the LSP output channel isn't visible
let _fallback_channel: vscode.OutputChannel | undefined;
function log(msg: string): void {
	console.log(`ree-lsp: ${msg}`);
	if (!_fallback_channel) _fallback_channel = vscode.window.createOutputChannel("ree LSP (fallback)");
	_fallback_channel.appendLine(msg);
}

interface ServerConfig {
	command: string;
	args: string[];
	cwd: string | undefined;
}

interface ConfiguredSetting<T> {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;
}

function get_server_config(context: vscode.ExtensionContext): ServerConfig {
	const config = vscode.workspace.getConfiguration("ree");
	const command_setting = config.inspect<string>("server.command");
	const args_setting = config.inspect<string[]>("server.args");
	const cwd_setting = config.inspect<string>("server.cwd");
	const has_explicit_config = has_configured_value(command_setting)
		|| has_configured_value(args_setting)
		|| has_configured_value(cwd_setting);

	if (!has_explicit_config) {
		const bundled_server = path.join(context.extensionPath, "dist", "ree-lsp.cjs");

		return {
			command: "bun",
			args: [bundled_server, "--stdio"],
			cwd: undefined,
		};
	}

	const cwd = config.get<string>("server.cwd", "");

	return {
		command: config.get<string>("server.command", "bun"),
		args: config.get<string[]>("server.args", ["run", "src/server.ts", "--stdio"]),
		cwd: cwd || undefined,
	};
}

function has_configured_value<T>(setting: ConfiguredSetting<T> | undefined): boolean {
	if (!setting) return false;
	return setting.globalValue !== undefined
		|| setting.workspaceValue !== undefined
		|| setting.workspaceFolderValue !== undefined
		|| setting.globalLanguageValue !== undefined
		|| setting.workspaceLanguageValue !== undefined
		|| setting.workspaceFolderLanguageValue !== undefined;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

let client: LanguageClient | null = null;

export function create_lsp_client(context: vscode.ExtensionContext): LanguageClient {
	const { command, args, cwd } = get_server_config(context);

	const debug_args = [...args];
	const command_name = path.basename(command).toLowerCase();
	if (command_name === "bun" || command_name === "bun.exe") {
		debug_args.unshift("--inspect-brk=6009");
	}

	const server_options: ServerOptions = {
		run: {
			command,
			args: [...args],
			options: cwd ? { cwd } : undefined,
		},
		debug: {
			command,
			args: debug_args,
			options: cwd ? { cwd } : undefined,
		},
	};

	const client_options: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: language_id }],
		synchronize: {
			fileEvents: [
				vscode.workspace.createFileSystemWatcher("**/.reepolee/i18n/*.json"),
				vscode.workspace.createFileSystemWatcher("**/src/public/**/*.json"),
			],
		},
		// Don't flash "Loading..." in the status bar - the server starts
		// fast enough that the indicator is more distracting than helpful.
		progressOnInitialization: false,
	};

	const lsp_client = new LanguageClient(
		client_id,
		client_name,
		server_options,
		client_options,
	);

	client = lsp_client;
	return lsp_client;
}

export function start_client(client: LanguageClient, context: vscode.ExtensionContext): void {
	const server_config = get_server_config(context);
	log(`Starting LSP: command=${server_config.command}, cwd=${server_config.cwd || "(none)"}`);
	context.subscriptions.push(client);
	const start_promise = client.start();
	start_promise.then(() => {
		log("LSP server started successfully");
	}, (err) => {
		log(`Failed to start: ${err}`);
		console.error(`ree-lsp: Failed to start language server: ${err}`);
		vscode.window.showErrorMessage(
			`ree Language Server failed to start. Make sure Bun is installed or check the ree.server settings. Error: ${err}`,
		);
	});
}

export function show_fallback_channel(): void {
	if (_fallback_channel) _fallback_channel.show(true);
}

export function deactivate_client(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}
