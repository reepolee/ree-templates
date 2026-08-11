import * as vscode from 'vscode';

import { loadTranslations } from './loader';
import { get_default_locale } from './settings';

/**
 * Regex that matches a translation tag and captures the key path.
 * Matches: {_ ui.title }, {- descriptions.card }, or {@ descriptions.card }
 */
const TRANSLATION_TAG_RE = /\{[_@-]\s+([\w.]+)\s*\}/g;

/**
 * Escape characters that would break a markdown table cell.
 */
function escapeTableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * Hover provider for translation tags in .ree templates.
 *
 * Hovering over a translation key shows the value in all available locales:
 *
 *   EN: Welcome
 *   SL: Dobrodošli
 */
export function createTranslationHoverProvider(): vscode.HoverProvider {
	return {
		provideHover(document: vscode.TextDocument, position: vscode.Position) {
			const line = document.lineAt(position.line).text;

			// Find which tag (if any) the cursor is inside
			let match: RegExpExecArray | null;
			TRANSLATION_TAG_RE.lastIndex = 0;

			while ((match = TRANSLATION_TAG_RE.exec(line)) !== null) {
				const tagStart = match.index;
				const tagEnd = tagStart + match[0].length;

				if (position.character < tagStart || position.character > tagEnd) {
					continue;
				}

				const key = match[1];
				const keyStart = tagStart + 3; // after "{_ " or "{- "
				const keyEnd = keyStart + key.length;

				if (position.character < keyStart || position.character > keyEnd) {
					continue;
				}

				// Cursor is inside a valid translation tag - show hover
				const translations = loadTranslations(document.fileName);
				if (!translations) return undefined;

				const default_locale = get_default_locale();
				const md = new vscode.MarkdownString();
				md.isTrusted = true;
				md.supportHtml = true;

				md.appendMarkdown(`**Translation key:** \`${key}\`\n\n`);

				const default_data = translations[default_locale];
				const default_value = default_data?.[key];

				let hasAny = default_value !== undefined;
				let table = '| Locale&nbsp;&nbsp;&nbsp;&nbsp; | Translation |\n| --- | --- |\n';

				if (default_value !== undefined) {
					table += `| ⭐ ${default_locale.toUpperCase()} | **${escapeTableCell(default_value)}** |\n`;
				}

				// Then show all other locales
				for (const [locale, data] of Object.entries(translations)) {
					if (locale === default_locale) continue;
					const value = data[key];
					if (value !== undefined) {
						hasAny = true;
						table += `| ${locale.toUpperCase()} | **${escapeTableCell(value)}** |\n`;
					}
				}

				if (hasAny) {
					md.appendMarkdown(table);
				} else {
					md.appendMarkdown('_(key not found in any locale)_');
				}

				return new vscode.Hover(md);
			}

			return undefined;
		},
	};
}
