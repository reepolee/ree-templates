import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── i18n providers ─────────────────────────────────────────────────────────

import { createTranslationHoverProvider } from './i18n/hover';
import { createTranslationCompletionProvider } from './i18n/completion';
import { createTranslationDefinitionProvider } from './i18n/definition';
import {
	createTranslationDiagnostics,
	createTranslationCodeActionProvider,
} from './i18n/diagnostics';
import { createTranslationRenameProvider } from './i18n/rename';
import { createInlineDecorations } from './i18n/inline';
import { createLocaleStatusBarItem } from './i18n/statusBar';

// ─── IntelliSense Data ──────────────────────────────────────────────────────

interface ReeCompletion {
	label: string;
	detail: string;
	snippet: string;
	docs: string;
}

const TAG_COMPLETIONS: ReeCompletion[] = [
	{
		label: '{#if}',
		detail: 'Block: if condition',
		snippet: '{#if $1}\n\t$0\n{/if}',
		docs: 'Conditional block.',
	},
	{
		label: '{:else}',
		detail: 'Block: else branch',
		snippet: '{:else}',
		docs: 'Else branch.',
	},
	{
		label: '{/if}',
		detail: 'Close: if',
		snippet: '{/if}',
		docs: 'Closes if block.',
	},
];

const HELPER_COMPLETIONS: ReeCompletion[] = [
	{
		label: 'url',
		detail: '(path: string) => string',
		snippet: "url('$1')",
		docs: 'Build URL path.',
	},
];

// ─── FIXED: project root resolver (important change) ───────────────────────

function findProjectRoot(startDir: string): string {
	let dir = startDir;

	while (true) {
		// reefmt config FIRST (most important)
		if (fs.existsSync(path.join(dir, 'reefmt.jsonc'))) return dir;
		if (fs.existsSync(path.join(dir, 'reefmt.toml'))) return dir;

		// git fallback
		if (fs.existsSync(path.join(dir, '.git'))) return dir;

		const parent = path.dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return startDir;
}

// ─── formatter selection ────────────────────────────────────────────────────

type formatter_id = 'reefmt' | 'reettier';

// Resolve the executable command for a specific formatter. When the matching
// path setting is empty we fall back to the bare name so PATH lookup applies.
function resolve_cmd_for(config: vscode.WorkspaceConfiguration, formatter: formatter_id): string {
	if (formatter === 'reettier') {
		const reettier_path = config.get<string>('reettierPath', '');
		return reettier_path || 'reettier';
	}

	const reefmt_path = config.get<string>('reefmtPath', '');
	return reefmt_path || 'reefmt';
}

// Resolve the executable command for the selected formatter. reefmt is a
// standard AST reprinter, reettier is an indenter that keeps the user's line
// breaks. Both are executables that read source from stdin via --stdin.
function resolve_formatter_cmd(config: vscode.WorkspaceConfiguration): string {
	const formatter = config.get<formatter_id>('formatter', 'reefmt');
	return resolve_cmd_for(config, formatter);
}

// ─── formatter discovery (which + version) ──────────────────────────────────

interface formatter_status {
	formatter: formatter_id;
	cmd: string;
	// Absolute path when resolved, or null when the command could not be found.
	resolved_path: string | null;
	// Version string reported by the executable, or null when unavailable.
	version: string | null;
}

// Resolve a command to an absolute path. An explicit path is verified with
// fs.existsSync; a bare name is looked up on PATH honouring PATHEXT on Windows.
function which(cmd: string): string | null {
	// Explicit path (contains a separator) - just verify it exists.
	if (cmd.includes(path.sep) || cmd.includes('/')) {
		const exists = fs.existsSync(cmd);
		return exists ? cmd : null;
	}

	const path_env = process.env.PATH || '';
	const dirs = path_env.split(path.delimiter).filter(Boolean);

	const is_windows = process.platform === 'win32';
	const pathext = is_windows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM') : '';
	const exts = is_windows ? pathext.split(';').filter(Boolean) : [''];

	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, cmd + ext);
			if (fs.existsSync(candidate)) return candidate;
		}
	}

	return null;
}

// Query the executable for its version via `--version`. Returns the trimmed
// first line, or null when the command is missing or errors out.
function query_version(cmd: string): Promise<string | null> {
	return new Promise(resolve => {
		let p;
		try {
			p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			resolve(null);
			return;
		}

		let out = '';
		p.stdout.on('data', d => (out += d.toString()));
		p.stderr.on('data', d => (out += d.toString()));

		p.on('error', () => resolve(null));

		p.on('close', code => {
			const first_line = out.trim().split(/\r?\n/)[0] || '';
			if (code === 0 && first_line) resolve(first_line);
			else resolve(first_line || null);
		});
	});
}

// Probe both formatters and return their resolved path and version.
async function check_formatters(config: vscode.WorkspaceConfiguration): Promise<formatter_status[]> {
	const ids: formatter_id[] = ['reefmt', 'reettier'];
	const results: formatter_status[] = [];

	for (const formatter of ids) {
		const cmd = resolve_cmd_for(config, formatter);
		const resolved_path = which(cmd);
		const version = resolved_path ? await query_version(resolved_path) : null;

		results.push({ formatter, cmd, resolved_path, version });
	}

	return results;
}

// ─── formatter runner (unchanged idea, just safer) ─────────────────────────

function run_formatter(cmd: string, cwd: string, input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, ['--stdin'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let out = '';
		let err = '';

		p.stdout.on('data', d => (out += d.toString()));
		p.stderr.on('data', d => (err += d.toString()));

		p.on('close', code => {
			if (code === 0) resolve(out);
			else reject(new Error(err || `${cmd} failed (${code})`));
		});

		p.stdin.write(input);
		p.stdin.end();
	});
}

// ─── IntelliSense helper ────────────────────────────────────────────────────

function buildItems(list: ReeCompletion[]) {
	return list.map(c => {
		const item = new vscode.CompletionItem(
			c.label,
			vscode.CompletionItemKind.Snippet
		);

		item.insertText = new vscode.SnippetString(c.snippet);
		item.detail = c.detail;
		item.documentation = new vscode.MarkdownString(c.docs);

		return item;
	});
}

// ─── activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {

	// ─── FORMATTER ──────────────────────────────────────────────────────────

	const formatter = vscode.languages.registerDocumentFormattingEditProvider(
		'ree',
		{
			async provideDocumentFormattingEdits(document) {

				const config = vscode.workspace.getConfiguration('ree', document.uri);
				const cmd = resolve_formatter_cmd(config);

				const fileDir = path.dirname(document.fileName);

				// ✅ ONLY REAL FIX: use project root resolver
				const cwd = findProjectRoot(fileDir);

				try {
					const formatted = await run_formatter(
						cmd,
						cwd,
						document.getText()
					);

					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(document.getText().length)
					);

					return [vscode.TextEdit.replace(fullRange, formatted)];

				} catch (err: any) {
					vscode.window.showErrorMessage(
						`${cmd} failed: ${err.message ?? err}`
					);
					return [];
				}
			},
		}
	);

	// ─── command ────────────────────────────────────────────────────────────

	const formatCommand = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	// ─── check formatters (which + version) ──────────────────────────────────

	const checkFormattersCommand = vscode.commands.registerCommand('ree.checkFormatters', async () => {
		const doc_uri = vscode.window.activeTextEditor?.document.uri;
		const config = vscode.workspace.getConfiguration('ree', doc_uri);
		const selected = config.get<formatter_id>('formatter', 'reefmt');

		const statuses = await check_formatters(config);

		const lines = statuses.map(s => {
			const active = s.formatter === selected ? ' (active)' : '';

			if (!s.resolved_path) {
				return `${s.formatter}${active}: not found (looked for "${s.cmd}")`;
			}

			const version = s.version ?? 'version unknown';
			return `${s.formatter}${active}: ${version} at ${s.resolved_path}`;
		});

		const summary = lines.join('\n');
		const channel = vscode.window.createOutputChannel('ree Formatters');
		channel.clear();
		channel.appendLine(summary);
		channel.show(true);

		vscode.window.showInformationMessage(summary, { modal: false });
	});

	// ─── completion providers (tags + helpers) ──────────────────────────────

	const tagProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document, position) {
				const line = document.lineAt(position).text.slice(0, position.character);
				if (!line.endsWith('{')) return;
				return buildItems(TAG_COMPLETIONS);
			},
		},
		'{'
	);

	const helperProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems() {
				return buildItems(HELPER_COMPLETIONS);
			},
		}
	);

	// ─── i18n providers ─────────────────────────────────────────────────────

	// 1. Hover — show values from all locales
	const translationHoverProvider = vscode.languages.registerHoverProvider(
		{ language: 'ree' },
		createTranslationHoverProvider()
	);

	// 2. Completion — suggest translation keys inside {_ / {- tags
	const translationCompletionProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		createTranslationCompletionProvider(),
		'_',
		'-',
		'.',
		' '
	);

	// 3. Go To Definition — Ctrl+Click opens locale JSON at the key
	const translationDefinitionProvider = vscode.languages.registerDefinitionProvider(
		{ language: 'ree' },
		createTranslationDefinitionProvider()
	);

	// 4. Diagnostics — underline unknown translation keys
	const { collection: translationDiagnostics, watcher: translationWatcher, updateDocument } =
		createTranslationDiagnostics();

	// Update diagnostics on document open/change
	const diagnosticSub = vscode.workspace.onDidOpenTextDocument(updateDocument);
	const changeSub = vscode.workspace.onDidChangeTextDocument(e => updateDocument(e.document));
	const closeSub = vscode.workspace.onDidCloseTextDocument(doc => {
		translationDiagnostics.delete(doc.uri);
	});

	// Run diagnostics on initially visible documents
	for (const editor of vscode.window.visibleTextEditors) {
		updateDocument(editor.document);
	}

	// 5. Code Actions — Quick Fix to create missing keys
	const codeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: 'ree' },
		createTranslationCodeActionProvider(),
		{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
	);

	// 6. Rename — F2 renames keys across .ree + .json files
	const renameProvider = vscode.languages.registerRenameProvider(
		{ language: 'ree' },
		createTranslationRenameProvider()
	);

	// 7. Inline decorations — show → translated value after {_ / {- tags
	const inlineDecorations = createInlineDecorations();

	// 8. Status bar — language switcher
	const localeStatusBar = createLocaleStatusBarItem();

	// 9. Inline refresh command (called when locale changes via status bar)
	const refreshInlineCmd = vscode.commands.registerCommand('ree._refreshInline', () => {
		inlineDecorations.refresh();
	});

	// ─── push all subscriptions ─────────────────────────────────────────────

	context.subscriptions.push(
		formatter,
		formatCommand,
		checkFormattersCommand,
		tagProvider,
		helperProvider,

		// i18n
		translationHoverProvider,
		translationCompletionProvider,
		translationDefinitionProvider,
		translationDiagnostics,
		translationWatcher,
		diagnosticSub,
		changeSub,
		closeSub,
		codeActionProvider,
		renameProvider,
		inlineDecorations,
		localeStatusBar,
		refreshInlineCmd,
	);
}

export function deactivate() { }
