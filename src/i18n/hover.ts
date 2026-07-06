import * as vscode from 'vscode';

import { loadTranslations } from './loader';
import { getDefaultLocale } from './settings';

/**
 * Regex that matches a translation tag and captures the key path.
 * Matches: {_ ui.title } or {- descriptions.card }
 */
const TRANSLATION_TAG_RE = /\{[_-]\s+([\w.]+)\s*\}/g;

/**
 * Hover provider for {_ key } and {- key } translation tags in .ree templates.
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

				// Cursor is inside a valid translation tag — show hover
				const translations = loadTranslations(document.fileName);
				if (!translations) return undefined;

				const defaultLocale = getDefaultLocale();
				const md = new vscode.MarkdownString();
				md.isTrusted = true;
				md.supportHtml = true;

				md.appendMarkdown(`**Translation key:** \`${key}\`\n\n`);

				// Show the selected/default locale first with emphasis
				const defaultData = translations[defaultLocale];
				const defaultVal = defaultData?.[key];

				if (defaultVal !== undefined) {
					md.appendCodeblock(defaultVal, 'text');
					md.appendMarkdown(`⭐ **${defaultLocale.toUpperCase()}** *(default)*\n\n`);
				}

				// Then show all other locales
				let hasOthers = false;
				for (const [locale, data] of Object.entries(translations)) {
					if (locale === defaultLocale) continue;
					const value = data[key];
					if (value !== undefined) {
						hasOthers = true;
						md.appendCodeblock(value, 'text');
						md.appendMarkdown(`— *${locale.toUpperCase()}*\n\n`);
					}
				}

				if (defaultVal === undefined && !hasOthers) {
					md.appendMarkdown('_(key not found in any locale)_');
				}

				return new vscode.Hover(md);
			}

			return undefined;
		},
	};
}
