import * as vscode from 'vscode';

import { getTranslationKeys } from './loader';

/**
 * Completion provider for translation keys inside translation tags.
 *
 * When the user types inside a translation tag, it offers all available
 * translation keys from en.json / sl.json in the same directory.
 *
 * Supports dot-separated partial matching, e.g. typing "ui.ti" suggests "ui.title".
 */
export function createTranslationCompletionProvider(): vscode.CompletionItemProvider {
	return {
		provideCompletionItems(
			document: vscode.TextDocument,
			position: vscode.Position
		) {
			const line = document.lineAt(position.line).text;
			const linePrefix = line.slice(0, position.character);

			// Find the last translation tag before the cursor
			const tagMatch = linePrefix.match(/\{[_@-]\s+([\w.]*)$/);
			if (!tagMatch) return undefined;

			const partialKey = tagMatch[1];
			const keys = getTranslationKeys(document.fileName);
			if (!keys) return undefined;

			// Filter keys by the partial input
			const matchedKeys = partialKey
				? keys.filter(k => k.startsWith(partialKey))
				: keys;

			if (matchedKeys.length === 0) return undefined;

			// Determine the start character of the key inside the tag
			const tagStartIndex = linePrefix.lastIndexOf('{');
			const keyStartCharIndex = tagStartIndex + 3; // after "{_ " or "{- "

			const startPos = new vscode.Position(position.line, keyStartCharIndex);

			const range = new vscode.Range(startPos, position);

			return matchedKeys.map(key => {
				const item = new vscode.CompletionItem(
					key,
					vscode.CompletionItemKind.Constant
				);
				item.range = range;
				item.insertText = key;

				// Show the value for the first available locale as detail
				const itemDoc = new vscode.MarkdownString();
				itemDoc.isTrusted = true;
				item.documentation = itemDoc;

				return item;
			});
		},
	};
}
