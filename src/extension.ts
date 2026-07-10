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
		// git fallback
		if (fs.existsSync(path.join(dir, '.git'))) return dir;

		const parent = path.dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return startDir;
}

// ─── formatter selection ────────────────────────────────────────────────────

// Resolve the executable command for reettier. When the path setting is empty
// we fall back to the bare name so PATH lookup applies.
function resolve_formatter_cmd(config: vscode.WorkspaceConfiguration): string {
	const reettier_path = config.get<string>('reettierPath', '');
	return reettier_path || 'reettier';
}

// ─── formatter discovery (version) ───────────────────────────────────────────

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

// Probe the real installed reettier CLI and return its version. We look it up
// by its own name (not the formatting path override) so a path shim does not
// mask the genuine version.
async function check_formatters(): Promise<string | null> {
	return query_version('reettier');
}

// ─── formatter runner (unchanged idea, just safer) ─────────────────────────

function run_formatter(cmd: string, cwd: string, input: string, extraArgs: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, ['--stdin', ...extraArgs], {
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

	// ─── format with reprint (full AST re-derivation via reettier --full) ───

	const formatWithReprintCommand = vscode.commands.registerCommand('ree.formatWithReprint', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'ree') {
			return;
		}

		const document = editor.document;
		const config = vscode.workspace.getConfiguration('ree', document.uri);
		const cmd = resolve_formatter_cmd(config);
		const cwd = findProjectRoot(path.dirname(document.fileName));

		try {
			const formatted = await run_formatter(cmd, cwd, document.getText(), ['--full']);

			const fullRange = new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length)
			);

			await editor.edit(editBuilder => {
				editBuilder.replace(fullRange, formatted);
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(
				`${cmd} --full failed: ${err.message ?? err}`
			);
		}
	});

	// ─── check formatters (installed versions) ───────────────────────────────

	const checkFormattersCommand = vscode.commands.registerCommand('ree.checkFormatters', async () => {
		const version = await check_formatters();
		const summary = version ? `reettier: ${version}` : 'reettier: not installed';
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

	// 2. Completion — suggest translation keys inside translation tags
	const translationCompletionProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		createTranslationCompletionProvider(),
		'_',
		'-',
		'@',
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
		formatWithReprintCommand,
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
