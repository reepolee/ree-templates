import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

	// ─── completion providers ───────────────────────────────────────────────

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
			provideCompletionItems(document, position) {
				return buildItems(HELPER_COMPLETIONS);
			},
		}
	);

	context.subscriptions.push(formatter, formatCommand, tagProvider, helperProvider);
}

export function deactivate() { }
