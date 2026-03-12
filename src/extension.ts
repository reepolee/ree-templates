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
	values?: Array<{ name: string; description?: string }>;
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
	const ext = vscode.extensions.getExtension('pcbowers.alpine-intellisense');
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

// ─── Cursor context helpers ───────────────────────────────────────────────────

interface TagContext {
	/** Cursor is somewhere inside an opening tag */
	inTag: boolean;
	/** Cursor is inside a quoted attribute value; holds the attribute name */
	inAttributeValue: string | null;
	/** Partial word being typed at cursor position */
	wordPrefix: string;
}

/**
 * Analyses the text on the current line up to the cursor to determine whether
 * the cursor is:
 *   (a) inside an opening HTML/REE tag (but not in a value) → attribute completions
 *   (b) inside a quoted attribute value                      → value / expression completions
 *   (c) neither                                              → no alpine completions
 */
function getTagContext(lineText: string, position: vscode.Position): TagContext {
	const prefix = lineText.slice(0, position.character);
	const lastOpen = prefix.lastIndexOf('<');

	if (lastOpen === -1) {
		return { inTag: false, inAttributeValue: null, wordPrefix: '' };
	}

	const afterOpen = prefix.slice(lastOpen);

	// Closing tag — no completions
	if (afterOpen.startsWith('</')) {
		return { inTag: false, inAttributeValue: null, wordPrefix: '' };
	}

	// Tag already closed before cursor
	if (afterOpen.includes('>')) {
		return { inTag: false, inAttributeValue: null, wordPrefix: '' };
	}

	// Determine quote balance to detect if we're inside an attribute value
	// Walk character-by-character to handle escaped quotes robustly
	let inSingle = false;
	let inDouble = false;
	let currentAttr = '';
	let lastAttrName = '';

	for (let i = 0; i < afterOpen.length; i++) {
		const ch = afterOpen[i];

		if (ch === "'" && !inDouble) {
			if (!inSingle) {
				// Opening single-quote — capture the attribute name that precedes it
				lastAttrName = currentAttr.trim().replace(/.*[\s=]/, '');
			}
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			if (!inDouble) {
				lastAttrName = currentAttr.trim().replace(/.*[\s=]/, '');
			}
			inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble) {
			currentAttr += ch;
		}
	}

	const insideValue = inSingle || inDouble;

	// Word prefix at cursor (for filtering)
	const wordMatch = prefix.match(/[\w\-@:.]+$/);
	const wordPrefix = wordMatch ? wordMatch[0] : '';

	if (insideValue) {
		return { inTag: true, inAttributeValue: lastAttrName, wordPrefix };
	}

	return { inTag: true, inAttributeValue: null, wordPrefix };
}

// ─── Completion builders ──────────────────────────────────────────────────────

/** Build attribute-level completion items (x-data, x-show, @click, :class …) */
function buildAttributeItems(attributes: AlpineAttribute[]): vscode.CompletionItem[] {
	return attributes.map((attr) => {
		const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
		const desc = typeof attr.description === 'object' ? attr.description.value : attr.description;
		if (desc) {
			item.documentation = new vscode.MarkdownString(desc);
		}
		// Insert `attr="<cursor>"` and place cursor inside the quotes
		item.insertText = new vscode.SnippetString(`${attr.name}="$1"$0`);
		item.sortText = `0_${attr.name}`;
		// Boost relevance for Alpine-prefixed names
		item.detail = 'Alpine.js';
		return item;
	});
}

/** Build snippet-level completion items */
function buildSnippetItems(snippets: Record<string, AlpineSnippet>): vscode.CompletionItem[] {
	return Object.entries(snippets).map(([name, snippet]) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Snippet);
		const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
		item.insertText = new vscode.SnippetString(body);
		if (snippet.description) {
			item.documentation = new vscode.MarkdownString(snippet.description);
		}
		const prefix = Array.isArray(snippet.prefix) ? snippet.prefix[0] : snippet.prefix;
		item.filterText = prefix;
		item.sortText = `1_${name}`;
		item.detail = 'Alpine.js snippet';
		return item;
	});
}

/**
 * Build completions for the *value* side of a known attribute.
 * E.g. inside x-transition, offer the known modifier names.
 */
function buildAttributeValueItems(attrName: string, attributes: AlpineAttribute[]): vscode.CompletionItem[] {
	const attr = attributes.find((a) => a.name === attrName);
	if (!attr?.values?.length) return [];

	return attr.values.map((val) => {
		const item = new vscode.CompletionItem(val.name, vscode.CompletionItemKind.Value);
		if (val.description) {
			item.documentation = new vscode.MarkdownString(val.description);
		}
		item.detail = `${attrName} value`;
		item.sortText = `0_${val.name}`;
		return item;
	});
}

// ─── Provider registration ────────────────────────────────────────────────────

function registerAlpineSupport(context: vscode.ExtensionContext): void {
	const data = loadAlpineData();
	if (!data) return;

	const { snippets, attributes } = data;

	// ── 1. Attribute name provider ──────────────────────────────────────────
	// Triggered by x, @, : and space so Alpine attributes surface immediately.
	// Fine-grained gating is handled inside provideCompletionItems.
	const attrProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
				const lineText = document.lineAt(position).text;
				const ctx = getTagContext(lineText, position);

				// Only fire when inside a tag but NOT inside a quoted value
				if (!ctx.inTag || ctx.inAttributeValue !== null) return undefined;

				return [...buildAttributeItems(attributes), ...buildSnippetItems(snippets)];
			},
		},
		// Trigger characters that begin Alpine attribute names or shorthands
		'x',
		'@',
		':',
		' ',
		'\t',
	);

	// ── 2. Attribute value provider ─────────────────────────────────────────
	// Fires when the cursor is inside a quoted value of an Alpine attribute.
	const valueProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'ree' },
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
				const lineText = document.lineAt(position).text;
				const ctx = getTagContext(lineText, position);

				if (!ctx.inTag || ctx.inAttributeValue === null) return undefined;

				return buildAttributeValueItems(ctx.inAttributeValue, attributes);
			},
		},
		// Trigger inside attribute values
		'"',
		"'",
		' ',
	);

	// ── 3. Hover provider — show Alpine docs on hover ───────────────────────
	const hoverProvider = vscode.languages.registerHoverProvider(
		{ language: 'ree' },
		{
			provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
				const wordRange = document.getWordRangeAtPosition(position, /[@:x][\w\-:.]+|x-[\w\-:.]+/);
				if (!wordRange) return undefined;

				const word = document.getText(wordRange);
				const attr = attributes.find((a) => a.name === word || a.name === word.replace(/^:/, 'x-bind:').replace(/^@/, 'x-on:'));
				if (!attr) return undefined;

				const desc = typeof attr.description === 'object' ? attr.description.value : (attr.description ?? '');

				const md = new vscode.MarkdownString();
				md.appendMarkdown(`**Alpine.js** \`${attr.name}\`\n\n${desc}`);
				md.isTrusted = true;
				return new vscode.Hover(md, wordRange);
			},
		},
	);

	context.subscriptions.push(attrProvider, valueProvider, hoverProvider);
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
