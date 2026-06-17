import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReeCompletion {
	label: string;
	detail: string;
	snippet: string;
	docs: string;
}

// ─── Completion Data ────────────────────────────────────────────────────────

const TAG_COMPLETIONS: ReeCompletion[] = [
	{
		label: '{#if}',
		detail: 'Block: if condition',
		snippet: '{#if $1}\n\t$0\n{/if}',
		docs: 'Conditional block. Renders content when condition is truthy.',
	},
	{
		label: '{:else}',
		detail: 'Block: else branch',
		snippet: '{:else}',
		docs: 'Else branch for conditional blocks.',
	},
	{
		label: '{/if}',
		detail: 'Close: if',
		snippet: '{/if}',
		docs: 'Closes an if block.',
	},
	{
		label: '{#each}',
		detail: 'Block: each iteration',
		snippet: '{#each $1 as $2}\n\t$0\n{/each}',
		docs: 'Iteration block over arrays or objects.',
	},
];

const HELPER_COMPLETIONS: ReeCompletion[] = [
	{
		label: 'url',
		detail: '(path: string) => string',
		snippet: "url('$1')",
		docs: 'Ensures path starts with /',
	},
	{
		label: 'locale_date',
		detail: '(date: string) => string',
		snippet: 'locale_date($1)',
		docs: 'Formats date in locale format.',
	},
];

// ─── Git Root Resolver ──────────────────────────────────────────────────────

function findGitRoot(startDir: string): string {
	let dir = startDir;

	while (true) {
		if (fs.existsSync(path.join(dir, '.git'))) return dir;

		const parent = path.dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return startDir;
}

// ─── REE Expression Detection ───────────────────────────────────────────────

function isInsideReeExpression(
	document: vscode.TextDocument,
	position: vscode.Position
): boolean {
	const text = document.getText(
		new vscode.Range(new vscode.Position(0, 0), position)
	);

	let lastIdx = -1;
	let lastMatch = '';

	const openerRe = /\{(?:[#=~@/:]|\{)/g;
	let m: RegExpExecArray | null;

	while ((m = openerRe.exec(text)) !== null) {
		lastIdx = m.index;
		lastMatch = m[0];
	}

	if (lastIdx === -1) return false;

	const after = text.slice(lastIdx);

	if (lastMatch === '{{') {
		return after.indexOf('}}', 2) === -1;
	}

	return after.indexOf('}', 2) === -1;
}

// ─── Completion Builder ─────────────────────────────────────────────────────

function buildItems(completions: ReeCompletion[]): vscode.CompletionItem[] {
	return completions.map((c) => {
		const item = new vscode.CompletionItem(
			c.label,
			vscode.CompletionItemKind.Snippet
		);

		item.insertText = new vscode.SnippetString(c.snippet);
		item.detail = c.detail;
		item.documentation = new vscode.MarkdownString(c.docs);
		item.sortText = '0_' + c.label;

		return item;
	});
}

// ─── Formatter (spawn-based, stdin/stdout) ──────────────────────────────────

function runReefmt(cmd: string, cwd: string, input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, ['--stdin'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let out = '';
		let err = '';

		p.stdout.on('data', (d) => (out += d.toString()));
		p.stderr.on('data', (d) => (err += d.toString()));

		p.on('close', (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(err || `reefmt exited with code ${code}`));
		});

		p.stdin.write(input);
		p.stdin.end();
	});
}

// ─── IntelliSense Registration ──────────────────────────────────────────────

function registerIntelliSense(context: vscode.ExtensionContext) {
	const tagProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document, position) {
				const line = document.lineAt(position).text.slice(0, position.character);

				if (!line.endsWith('{')) return;
				if (line.endsWith('{{')) return;
				if (/\{[#=~@/:]/.test(line.slice(-2))) return;

				return buildItems(TAG_COMPLETIONS);
			},
		},
		'{'
	);

	const helperProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document, position) {
				if (!isInsideReeExpression(document, position)) return;
				return buildItems(HELPER_COMPLETIONS);
			},
		}
	);

	const hoverProvider = vscode.languages.registerHoverProvider(
		{ language: 'ree' },
		{
			provideHover(document, position) {
				if (!isInsideReeExpression(document, position)) return;

				const range = document.getWordRangeAtPosition(
					position,
					/[a-zA-Z_][a-zA-Z0-9_]*/
				);

				if (!range) return;

				const word = document.getText(range);
				const helper = HELPER_COMPLETIONS.find((h) => h.label === word);
				if (!helper) return;

				const md = new vscode.MarkdownString();
				md.appendMarkdown(
					`**${helper.label}**\n\n\`${helper.detail}\`\n\n${helper.docs}`
				);
				md.isTrusted = true;

				return new vscode.Hover(md, range);
			},
		}
	);

	context.subscriptions.push(tagProvider, helperProvider, hoverProvider);
}

// ─── Activation ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	const formatter = vscode.languages.registerDocumentFormattingEditProvider(
		'ree',
		{
			async provideDocumentFormattingEdits(document) {
				const config = vscode.workspace.getConfiguration('ree');
				const cmd = config.get<string>('reefmtPath', '') || 'reefmt';

				const fileDir = path.dirname(document.fileName);

				const workspaceFolder = vscode.workspace.getWorkspaceFolder(
					document.uri
				);

				const cwd =
					workspaceFolder?.uri.fsPath ?? findGitRoot(fileDir) ?? fileDir;

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

	const formatCommand = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	context.subscriptions.push(formatter, formatCommand);

	registerIntelliSense(context);
}

export function deactivate() { }
