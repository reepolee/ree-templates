import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { html as beautifyHtml } from 'js-beautify';

// ─── Alpine Integration ───────────────────────────────────────────────────────

interface AlpineSnippet {
	prefix: string | string[];
	body: string | string[];
	description?: string;
}

interface AlpineAttribute {
	name: string;
	description?: string | { value: string };
}

interface AlpineData {
	snippets: Record<string, AlpineSnippet>;
	attributes: AlpineAttribute[];
}

function loadAlpineData(): AlpineData | null {
	const ext = vscode.extensions.getExtension('adrianwilczynski.alpine-js-intellisense');
	if (!ext) return null;

	try {
		const extPath = ext.extensionPath;

		const snippets: Record<string, AlpineSnippet> = JSON.parse(fs.readFileSync(path.join(extPath, 'snippets', 'html.json'), 'utf8'));

		const customData = JSON.parse(fs.readFileSync(path.join(extPath, 'out', 'data', 'htmlData.json'), 'utf8'));

		const attributes: AlpineAttribute[] = customData?.globalAttributes ?? [];

		return { snippets, attributes };
	} catch {
		return null;
	}
}

function registerAlpineSupport(context: vscode.ExtensionContext): void {
	const data = loadAlpineData();
	if (!data) return;

	const { snippets, attributes } = data;

	// Snippet completions (x-data="{ ... }", @click="...", etc.)
	const snippetProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.slice(0, position.character);
				if (!/<[^>]*$/.test(linePrefix)) return undefined;

				return Object.entries(snippets).map(([name, snippet]) => {
					const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
					const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
					item.insertText = new vscode.SnippetString(body);
					if (snippet.description) {
						item.documentation = new vscode.MarkdownString(snippet.description);
					}
					const prefix = Array.isArray(snippet.prefix) ? snippet.prefix[0] : snippet.prefix;
					item.filterText = prefix;
					return item;
				});
			},
		},
		' ',
		':',
		'@',
	);

	// Attribute name completions from customData (x-show, x-bind, etc.)
	const attributeProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.slice(0, position.character);
				if (!/<[^>]*$/.test(linePrefix)) return undefined;

				return attributes.map((attr) => {
					const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
					const desc = typeof attr.description === 'object' ? attr.description.value : attr.description;
					if (desc) {
						item.documentation = new vscode.MarkdownString(desc);
					}
					item.insertText = new vscode.SnippetString(`${attr.name}="$1"$0`);
					return item;
				});
			},
		},
		' ',
		':',
		'@',
		'x',
		'-',
	);

	context.subscriptions.push(snippetProvider, attributeProvider);
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	const formatter = vscode.languages.registerDocumentFormattingEditProvider('ree', {
		provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
			const config = vscode.workspace.getConfiguration('ree');
			const indentationType = config.get<string>('indentationType', 'spaces');
			const tabSize = config.get<number>('tabSize', 2);
			const formatted = formatReeTemplate(document.getText(), indentationType, tabSize);
			const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
			return [vscode.TextEdit.replace(fullRange, formatted)];
		},
	});

	const command = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	context.subscriptions.push(formatter, command);

	// Register Alpine support if the extension is installed.
	// Re-register if extensions change (e.g. user installs Alpine mid-session).
	registerAlpineSupport(context);
	context.subscriptions.push(vscode.extensions.onDidChange(() => registerAlpineSupport(context)));
}

// ─── Formatter ────────────────────────────────────────────────────────────────

function formatReeTemplate(content: string, indentationType: string, tabSize: number): string {
	// Step 1: Protect ree tags by replacing them with placeholders
	const reeTagMap: Map<string, string> = new Map();
	let placeholderIndex = 0;

	const protectedContent = content.replace(/\{[#=~@:\/].*?\}/g, (match) => {
		const placeholder = `___REE_PLACEHOLDER_${placeholderIndex}___`;
		reeTagMap.set(placeholder, match);
		placeholderIndex++;
		return placeholder;
	});

	// Step 2: Format HTML using js-beautify
	const beautified = beautifyHtml(protectedContent, {
		indent_size: indentationType === 'tabs' ? 1 : tabSize,
		indent_char: indentationType === 'tabs' ? '\t' : ' ',
		wrap_line_length: 0,
		preserve_newlines: true,
		max_preserve_newlines: 2,
		indent_inner_html: true,
		end_with_newline: false,
		unformatted: [],
		content_unformatted: ['pre', 'textarea'],
	});

	// Step 3: Restore ree tags
	let result = beautified;
	reeTagMap.forEach((original, placeholder) => {
		result = result.replace(placeholder, original);
	});

	// Step 4: Fix indentation for ree control structures
	result = adjustReeIndentation(result, indentationType, tabSize);

	return result;
}

function adjustReeIndentation(content: string, indentationType: string, tabSize: number): string {
	const lines = content.split('\n');
	const formatted: string[] = [];
	const indent = indentationType === 'tabs' ? '\t' : ' '.repeat(tabSize);
	let reeIndentAdjustment = 0;

	for (const line of lines) {
		const trimmed = line.trim();

		// Check for else statement (closes one block, opens another)
		if (isReeElse(trimmed)) {
			reeIndentAdjustment--;
		} else if (isReeClosing(trimmed)) {
			reeIndentAdjustment--;
		}

		// Get base indentation from HTML formatter
		const baseIndent = line.match(/^[\t ]*/)?.[0] || '';
		const baseIndentLevel = indentationType === 'tabs' ? baseIndent.length : Math.floor(baseIndent.length / tabSize);

		// Apply ree adjustment
		const totalIndent = Math.max(0, baseIndentLevel + reeIndentAdjustment);
		formatted.push(indent.repeat(totalIndent) + trimmed);

		// Check for ree opening tags (including else which opens after closing)
		if (isReeOpening(trimmed)) {
			reeIndentAdjustment++;
		}
	}

	return formatted.join('\n');
}

function isReeOpening(line: string): boolean {
	return /\{#(if|each|unless|await)\b/.test(line) || isReeElse(line);
}

function isReeClosing(line: string): boolean {
	if (isReeElse(line)) return false;
	return /\{\/[a-z]+\s*\}/.test(line);
}

function isReeElse(line: string): boolean {
	return /\{:else(\s+if\b)?\b/.test(line);
}

export function deactivate() {}
