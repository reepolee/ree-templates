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
 * | Symbols              | N/A (new)               | LSP       |
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

import { get_default_locale } from "./i18n/settings";

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

	const raw_command = config.get<string>("server.command", "bun");
	const configured_command = typeof raw_command === "string" ? raw_command.trim() : "";

	// A blank or non-string `ree.server.command` means "use the bundled server",
	// even when other server settings are present - VS Code's LanguageClient
	// rejects an empty command with "Unsupported server configuration".
	if (!has_explicit_config || !configured_command) {
		const bundled_server = path.join(context.extensionPath, "dist", "ree-lsp.cjs");

		return {
			command: "bun",
			args: [bundled_server, "--stdio"],
			cwd: undefined,
		};
	}

	const cwd = config.get<string>("server.cwd", "");

	const raw_args = config.get<string[]>("server.args", ["run", "src/server.ts", "--stdio"]);
	const configured_args = Array.isArray(raw_args) ? raw_args.map(String) : [];

	return {
		command: configured_command,
		args: configured_args,
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
		initializationOptions: {
			ree: {
				translation: {
					defaultLocale: get_default_locale(),
				},
				envVarDescriptionsPath: vscode.workspace
					.getConfiguration("ree")
					.get<string>("envVarDescriptionsPath", "config/env_var_descriptions.ts"),
			},
		},
		synchronize: {
			configurationSection: "ree",
			fileEvents: [
				vscode.workspace.createFileSystemWatcher("**/locales/*.json"),
				vscode.workspace.createFileSystemWatcher("**/src/public/**/*.json"),
				vscode.workspace.createFileSystemWatcher("**/config/env_var_descriptions.ts"),
				// ReeTag components are indexed by basename from any .ree file,
				// so creates/deletes anywhere invalidate the index.
				vscode.workspace.createFileSystemWatcher("**/*.ree"),
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

export function start_client(client: LanguageClient, context: vscode.ExtensionContext): Promise<void> {
	const server_config = get_server_config(context);
	log(`Starting LSP: command=${server_config.command}, cwd=${server_config.cwd || "(none)"}`);
	context.subscriptions.push(client);
	const start_promise = client.start();
	start_promise.then(() => {
		log("LSP server started successfully");
	}, (err: unknown) => {
		log(`Failed to start: ${err}`);
		console.error(`ree-lsp: Failed to start language server: ${err}`);
		vscode.window.showErrorMessage(
			`ree Language Server failed to start. Make sure Bun is installed or check the ree.server settings. Error: ${err}`,
		);
	});
	return start_promise;
}

export function show_fallback_channel(): void {
	if (_fallback_channel) _fallback_channel.show(true);
}

export function deactivate_client(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}

// ---------------------------------------------------------------------------
// Custom LSP requests (used by client-side providers)
// ---------------------------------------------------------------------------

/**
 * Fetch translations for a document via the LSP, which uses the project
 * profile to resolve locale files through the route shadow chain.
 * Returns locale → key → value, or null when the server is unavailable.
 */
export async function get_translations_via_lsp(document_uri: string): Promise<Record<string, Record<string, string>> | null> {
	if (!client || client.state !== 2 /* Running */) return null;
	try {
		return await client.sendRequest("ree/getTranslations", {
			textDocument: { uri: document_uri },
		});
	} catch {
		return null;
	}
}
