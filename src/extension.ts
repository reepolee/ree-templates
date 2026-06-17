import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileP = promisify(execFile);

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
		docs: 'Conditional block. Renders content when the condition is truthy.',
	},
	{
		label: '{:else}',
		detail: 'Block: else branch',
		snippet: '{:else}',
		docs: 'Else branch for {#if} or {#each} blocks.',
	},
	{
		label: '{/if}',
		detail: 'Close: if',
		snippet: '{/if}',
		docs: 'Closes an {#if} block.',
	},
	{
		label: '{#each}',
		detail: 'Block: each iteration',
		snippet: '{#each $1 as $2}\n\t$0\n{/each}',
		docs: 'Iteration block. Loops over an array or object.',
	},
	{
		label: '{#each index}',
		detail: 'Block: each with index',
		snippet: '{#each $1 as $2, $3}\n\t$0\n{/each}',
		docs: 'Iteration block with index variable.',
	},
	{
		label: '{#each key}',
		detail: 'Block: each with index and key',
		snippet: '{#each $1 as $2, $3, $4}\n\t$0\n{/each}',
		docs: 'Iteration block with index and key variables (for objects).',
	},
	{
		label: '{/each}',
		detail: 'Close: each',
		snippet: '{/each}',
		docs: 'Closes an {#each} block.',
	},
	{
		label: '{#layout}',
		detail: 'Block: layout wrapper',
		snippet: "{#layout('$1')}\n$0",
		docs: 'Layout declaration. Wraps the template body in a layout file.',
	},
	{
		label: '{#layout with data}',
		detail: 'Block: layout with data',
		snippet: "{#layout('$1', { $2 })}\n$0",
		docs: 'Layout declaration with extra data passed to the layout.',
	},
	{
		label: '{#include}',
		detail: 'Block: include partial',
		snippet: "{#include('$1')}",
		docs: 'Include another template inline. Receives current data.',
	},
	{
		label: '{#include with data}',
		detail: 'Block: include with data',
		snippet: "{#include('$1', { $2 })}",
		docs: 'Include another template with extra data object.',
	},
	{
		label: '{= }',
		detail: 'Escaped output',
		snippet: '{= $1 }',
		docs: 'Escaped HTML output. Converts & < > " \' to HTML entities.',
	},
	{
		label: '{~ }',
		detail: 'Unescaped output',
		snippet: '{~ $1 }',
		docs: 'Unescaped / raw HTML output. Use only with trusted content.',
	},
	{
		label: '{{ }}',
		detail: 'Raw JavaScript',
		snippet: '{{ $1 }}',
		docs: 'Raw JavaScript block. Executed during template compilation.',
	},
	{
		label: '{#with}',
		detail: 'Block: with scope',
		snippet: '{#with $1}\n\t$0\n{/with}',
		docs: 'Sets the scope context for property access inside the block. All variable references within the block resolve against the given expression\'s properties.',
	},
	{
		label: '{/with}',
		detail: 'Close: with',
		snippet: '{/with}',
		docs: 'Closes an {#with} block.',
	},
];

const HELPER_COMPLETIONS: ReeCompletion[] = [
	{
		label: 'url',
		detail: '(path: string) => string',
		snippet: "url('$1')",
		docs: 'Ensures a path starts with `/`. Use in href attributes.',
	},
	{
		label: 'localized_path',
		detail: '(canonicalPath: string) => string',
		snippet: "localized_path('$1')",
		docs: 'Localizes a canonical URL path to the current language.',
	},
	{
		label: 'is_current',
		detail: '(pageUrl: string) => string',
		snippet: "is_current('$1')",
		docs: 'Returns "font-bold nav-item current" if the URL matches the current page, otherwise "nav-item".',
	},
	{
		label: 'yes_no',
		detail: '(val: number, type?: "blank_green" | "red_green") => string',
		snippet: 'yes_no($1)',
		docs: 'Displays a boolean/numeric value as a styled "Yes" or "No". Default: "blank_green".',
	},
	{
		label: 'locale_date',
		detail: '(dateString: string, locale?: string) => string',
		snippet: 'locale_date($1)',
		docs: 'Formats a date string according to locale.',
	},
	{
		label: 'locale_time',
		detail: '(dateString: string, locale?: string) => string',
		snippet: 'locale_time($1)',
		docs: 'Formats a date string\'s time portion according to locale.',
	},
	{
		label: 'locale_ts',
		detail: '(dateString: string, locale?: string) => string',
		snippet: 'locale_ts($1)',
		docs: 'Formats a date string as full date+time according to locale.',
	},
	{
		label: 'iso_date',
		detail: '(dateString: string) => string',
		snippet: 'iso_date($1)',
		docs: 'Converts a date to ISO format string (e.g. for <time datetime>).',
	},
	{
		label: 'display_currency',
		detail: '(val: number, locale?: string, hide_zero?: boolean, symbol?: string) => string',
		snippet: 'display_currency($1)',
		docs: 'Formats a number as currency. Default symbol: €.',
	},
	{
		label: 'display_percent',
		detail: '(val: number, locale?: string) => string',
		snippet: 'display_percent($1)',
		docs: 'Formats a number as percentage (e.g. 0.15 → "15%").',
	},
];


function findGitRoot(startDir: string): string {
	let dir = startDir;

	while (true) {
		if (fs.existsSync(path.join(dir, '.git'))) {
			return dir;
		}

		const parent = path.dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return startDir;
}

// ─── Context Detection ──────────────────────────────────────────────────────

function isInsideReeExpression(document: vscode.TextDocument, position: vscode.Position): boolean {
	const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position));

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
	let closerAt = -1;

	if (lastMatch === '{{') {
		closerAt = after.indexOf('}}', 2);
	} else {
		closerAt = after.indexOf('}', 2);
	}

	return closerAt === -1;
}

// ─── Completion Builders ────────────────────────────────────────────────────

function buildItems(completions: ReeCompletion[]): vscode.CompletionItem[] {
	return completions.map((c) => {
		const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Snippet);
		item.insertText = new vscode.SnippetString(c.snippet);
		item.detail = c.detail;
		item.documentation = new vscode.MarkdownString(c.docs);
		item.sortText = '0_' + c.label;
		return item;
	});
}

// ─── Provider Registration ──────────────────────────────────────────────────

function registerIntelliSense(context: vscode.ExtensionContext) {
	const tagProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.slice(0, position.character);
				if (linePrefix.endsWith('{{')) return undefined;
				if (!linePrefix.endsWith('{')) return undefined;
				if (/\{[#=~@/:]/.test(linePrefix.slice(-2))) return undefined;
				return buildItems(TAG_COMPLETIONS);
			},
		},
		'{',
	);

	const helperProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				if (!isInsideReeExpression(document, position)) return undefined;
				return buildItems(HELPER_COMPLETIONS);
			},
		},
	);

	const hoverProvider = vscode.languages.registerHoverProvider(
		{ language: 'ree' },
		{
			provideHover(document: vscode.TextDocument, position: vscode.Position) {
				if (!isInsideReeExpression(document, position)) return undefined;

				const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
				if (!wordRange) return undefined;

				const word = document.getText(wordRange);
				const helper = HELPER_COMPLETIONS.find((h) => h.label === word);
				if (!helper) return undefined;

				const md = new vscode.MarkdownString();
				md.appendMarkdown(`**${helper.label}**\n\n\`${helper.detail}\`\n\n${helper.docs}`);
				md.isTrusted = true;
				return new vscode.Hover(md, wordRange);
			},
		},
	);

	context.subscriptions.push(tagProvider, helperProvider, hoverProvider);
}

// ─── Activation ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	const formatter = vscode.languages.registerDocumentFormattingEditProvider('ree', {
		async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {

			const config = vscode.workspace.getConfiguration('ree');
			const customPath = config.get<string>('reefmtPath', '');
			const cmd = customPath || 'reefmt';

			const filePath = document.fileName;
			const fileDir = path.dirname(filePath);

			// ✅ 1. Try workspace folder first (VS Code project root)
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

			// ✅ 2. fallback: git root (what you actually want for config files)
			const cwd =
				workspaceFolder?.uri.fsPath ??
				findGitRoot(fileDir) ??
				fileDir;

			try {
				// run formatter in correct project context
				await execFileP(cmd, [filePath], {
					timeout: 15000,
					cwd,
				});

				const formatted = fs.readFileSync(filePath, 'utf8');

				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);

				return [vscode.TextEdit.replace(fullRange, formatted)];
			} catch (err: any) {
				if (err.code === 'ENOENT') {
					vscode.window.showWarningMessage(
						'reefmt not found. Install reefmt or set "ree.reefmtPath".',
					);
				} else {
					const detail = err.stderr ?? err.message ?? String(err);
					vscode.window.showErrorMessage(`reefmt failed: ${detail}`);
				}

				return [];
			}
		},
	});

	const formatCommand = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	context.subscriptions.push(formatter, formatCommand);

	registerIntelliSense(context);
}

export function deactivate() { }
