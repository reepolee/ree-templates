import * as vscode from 'vscode';
import { html as beautifyHtml } from 'js-beautify';

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
}

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

	for (let line of lines) {
		const trimmed = line.trim();

		// Check for else statement (closes one block, opens another)
		if (isReeElse(trimmed)) {
			reeIndentAdjustment--;
		}
		// Check for other ree closing tags
		else if (isReeClosing(trimmed)) {
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
	// Check for opening control structures: {#if, {#each, etc.
	return /\{#(if|each|unless|await)\b/.test(line) || isReeElse(line);
}

function isReeClosing(line: string): boolean {
	// Check for closing tags {/if, {/each, etc., but not else statements
	if (isReeElse(line)) {
		return false;
	}
	return /\{\/[a-z]+\s*\}/.test(line);
}

function isReeElse(line: string): boolean {
	// Matches: {:else} or {:else if condition}
	return /\{:else(\s+if\b)?\b/.test(line);
}

export function deactivate() {}
