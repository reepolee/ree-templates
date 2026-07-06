import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { loadTranslations } from './loader';

/**
 * Regex that matches a translation tag and captures the key path.
 */
const TRANSLATION_TAG_RE = /\{[_-]\s+([\w.]+)\s*\}/g;

/**
 * Go To Definition provider for translation keys.
 *
 * Ctrl+Click on a translation key inside `{_ hero.title }` opens the
 * en.json file at the line where that key is defined.
 */
export function createTranslationDefinitionProvider(): vscode.DefinitionProvider {
	return {
		provideDefinition(
			document: vscode.TextDocument,
			position: vscode.Position
		): vscode.Definition | undefined {
			const line = document.lineAt(position.line).text;

			// Find which tag the cursor is inside
			let match: RegExpExecArray | null;
			TRANSLATION_TAG_RE.lastIndex = 0;

			while ((match = TRANSLATION_TAG_RE.exec(line)) !== null) {
				const tagStart = match.index;
				const tagEnd = tagStart + match[0].length;

				if (position.character < tagStart || position.character > tagEnd) {
					continue;
				}

				const key = match[1];
				const dir = path.dirname(document.fileName);

				// Try en.json first, then sl.json, then any other locale file
				const candidates = ['en.json', 'sl.json'];
				const files = fs.existsSync(dir)
					? fs.readdirSync(dir).filter(f => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))
					: [];

				const orderedFiles = [
					...candidates.filter(f => files.includes(f)),
					...files.filter(f => !candidates.includes(f)),
				];

				for (const file of orderedFiles) {
					const filePath = path.join(dir, file);
					try {
						const content = fs.readFileSync(filePath, 'utf-8');
						const parsed = JSON.parse(content) as Record<string, unknown>;

						// Navigate to the value through nested keys
						const parts = key.split('.');
						let current: unknown = parsed;
						for (const part of parts) {
							if (current && typeof current === 'object' && !Array.isArray(current)) {
								current = (current as Record<string, unknown>)[part];
							} else {
								current = undefined;
								break;
							}
						}

						if (current !== undefined && typeof current === 'string') {
							// Find the position of the value in the file
							const valueIndex = content.indexOf(`"${current}"`);
							if (valueIndex >= 0) {
								const uri = vscode.Uri.file(filePath);
								const defPos = document.positionAt(valueIndex);
								return new vscode.Location(uri, defPos);
							}

							// Fallback: find the key name itself
							const keyIndex = content.indexOf(`"${parts[parts.length - 1]}"`);
							if (keyIndex >= 0) {
								const uri = vscode.Uri.file(filePath);
								const defPos = document.positionAt(keyIndex);
								return new vscode.Location(uri, defPos);
							}
						}

						// At least open the file
						const uri = vscode.Uri.file(filePath);
						return new vscode.Location(uri, new vscode.Position(0, 0));
					} catch {
						continue;
					}
				}

				return undefined;
			}

			return undefined;
		},
	};
}
