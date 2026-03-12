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

/** Probe candidate paths since Alpine extension layout may vary by version */
function readAlpineJson(extPath: string, candidates: string[]): any | null {
	for (const candidate of candidates) {
		const full = path.join(extPath, candidate);
		if (fs.existsSync(full)) {
			try {
				return JSON.parse(fs.readFileSync(full, 'utf8'));
			} catch {
				continue;
			}
		}
	}
	return null;
}

function loadAlpineData(): AlpineData | null {
	const ext = vscode.extensions.getExtension('sperovita.alpinejs-syntax-highlight');
	if (!ext) return null;

	const extPath = ext.extensionPath;

	const snippets = readAlpineJson(extPath, ['snippets/html.json', 'snippets/snippets.json']);

	const customData = readAlpineJson(extPath, ['out/data/htmlData.json', 'data/htmlData.json', 'out/htmlData.json', 'htmlData.json']);

	if (!snippets && !customData) return null;

	return {
		snippets: snippets ?? {},
		attributes: customData?.globalAttributes ?? [],
	};
}

/** Returns true when the cursor is inside an HTML opening tag but not inside a quoted value */
function isCursorInHtmlTag(lineText: string, position: vscode.Position): boolean {
	const prefix = lineText.slice(0, position.character);
	// Must have an unclosed < before cursor
	const lastOpen = prefix.lastIndexOf('<');
	if (lastOpen === -1) return false;
	const afterOpen = prefix.slice(lastOpen);
	// Must not be a closing tag
	if (afterOpen.startsWith('</')) return false;
	// Must not have a closing > after the last <
	if (afterOpen.includes('>')) return false;
	// Must not be inside a quoted attribute value
	const singleQuotes = (afterOpen.match(/'/g) ?? []).length;
	const doubleQuotes = (afterOpen.match(/"/g) ?? []).length;
	if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) return false;
	return true;
}

function registerAlpineSupport(context: vscode.ExtensionContext): void {
	const data = loadAlpineData();
	if (!data) return;

	const { snippets, attributes } = data;

	// Single provider — no trigger characters so it runs on every keystroke.
	// Gated manually by isCursorInHtmlTag() instead.
	const provider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
				const lineText = document.lineAt(position).text;

				if (!isCursorInHtmlTag(lineText, position)) return undefined;

				const items: vscode.CompletionItem[] = [];

				// Attribute name completions (x-data, x-show, @click, :class …)
				for (const attr of attributes) {
					const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
					const desc = typeof attr.description === 'object' ? attr.description.value : attr.description;
					if (desc) {
						item.documentation = new vscode.MarkdownString(desc);
					}
					item.insertText = new vscode.SnippetString(`${attr.name}="$1"$0`);
					// Sort above default HTML completions
					item.sortText = `0_${attr.name}`;
					items.push(item);
				}

				// Snippet completions
				for (const [name, snippet] of Object.entries(snippets)) {
					const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Snippet);
					const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
					item.insertText = new vscode.SnippetString(body);
					if (snippet.description) {
						item.documentation = new vscode.MarkdownString(snippet.description);
					}
					const prefix = Array.isArray(snippet.prefix) ? snippet.prefix[0] : snippet.prefix;
					item.filterText = prefix;
					item.sortText = `1_${name}`;
					items.push(item);
				}

				return items;
			},
		},
		// No trigger characters registered — provider is always active inside .ree
	);

	context.subscriptions.push(provider);
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

	registerAlpineSupport(context);

	// Re-register if Alpine extension is installed mid-session
	context.subscriptions.push(vscode.extensions.onDidChange(() => registerAlpineSupport(context)));
}

// ─── Formatter ────────────────────────────────────────────────────────────────

function formatReeTemplate(content: string, indentationType: string, tabSize: number): string {
	const reeTagMap: Map<string, string> = new Map();
	let placeholderIndex = 0;

	const protectedContent = content.replace(/\{[#=~@:\/].*?\}/g, (match) => {
		const placeholder = `___REE_PLACEHOLDER_${placeholderIndex}___`;
		reeTagMap.set(placeholder, match);
		placeholderIndex++;
		return placeholder;
	});

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

	let result = beautified;
	reeTagMap.forEach((original, placeholder) => {
		result = result.replace(placeholder, original);
	});

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

		if (isReeElse(trimmed)) {
			reeIndentAdjustment--;
		} else if (isReeClosing(trimmed)) {
			reeIndentAdjustment--;
		}

		const baseIndent = line.match(/^[\t ]*/)?.[0] || '';
		const baseIndentLevel = indentationType === 'tabs' ? baseIndent.length : Math.floor(baseIndent.length / tabSize);

		const totalIndent = Math.max(0, baseIndentLevel + reeIndentAdjustment);
		formatted.push(indent.repeat(totalIndent) + trimmed);

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
