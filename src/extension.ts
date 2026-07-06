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

// ─── formatter runner (unchanged idea, just safer) ─────────────────────────

function runReefmt(cmd: string, cwd: string, input: string): Promise<string> {
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
			else reject(new Error(err || `reefmt failed (${code})`));
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

				const config = vscode.workspace.getConfiguration('ree');
				const cmd = config.get<string>('reefmtPath', '') || 'reefmt';

				const fileDir = path.dirname(document.fileName);

				// ✅ ONLY REAL FIX: use project root resolver
				const cwd = findProjectRoot(fileDir);

				try {
					const formatted = await runReefmt(
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
						`reefmt failed: ${err.message ?? err}`
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

	// ─── push all subscriptions ─────────────────────────────────────────────

	context.subscriptions.push(
		formatter,
		formatCommand,
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
	);
}

export function deactivate() { }
