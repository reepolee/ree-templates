import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { findTranslationDirs } from './loader';

/**
 * Regex to match a translation key inside {_ … } or {- … } tags.
 * Uses `g` flag so we can iterate all matches on a line.
 */
const TRANSLATION_TAG_RE = /\{[_-]\s+([\w.]+)\s*\}/g;

/**
 * Find the translation tag that contains the cursor position on the given line.
 * Returns the matched key, its range, and the full tag text, or undefined.
 */
function findTagAtPosition(
	line: string,
	character: number
): { key: string; linePos: number } | undefined {
	let match: RegExpExecArray | null;
	TRANSLATION_TAG_RE.lastIndex = 0;

	while ((match = TRANSLATION_TAG_RE.exec(line)) !== null) {
		const tagStart = match.index;
		const tagEnd = tagStart + match[0].length;

		if (character < tagStart || character > tagEnd) continue;

		const key = match[1];
		const keyStart = tagStart + 3; // after "{_ " or "{- "
		const keyEnd = keyStart + key.length;

		if (character < keyStart || character > keyEnd) continue;

		return { key, linePos: keyStart };
	}

	return undefined;
}

/**
 * Rename provider for translation keys.
 *
 * Renaming a key (F2) inside a `{_ key }` tag updates:
 * - All occurrences of the key in all .ree files across the workspace
 * - All occurrences in locale JSON files (en.json, sl.json, etc.)
 */
export function createTranslationRenameProvider(): vscode.RenameProvider {
	return {
		async prepareRename(
			document: vscode.TextDocument,
			position: vscode.Position
		): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
			const line = document.lineAt(position.line).text;
			const tag = findTagAtPosition(line, position.character);
			if (!tag) return undefined;

			const keyEnd = tag.linePos + tag.key.length;
			const range = new vscode.Range(
				new vscode.Position(position.line, tag.linePos),
				new vscode.Position(position.line, keyEnd)
			);

			return { range, placeholder: tag.key };
		},

		async provideRenameEdits(
			document: vscode.TextDocument,
			position: vscode.Position,
			newName: string
		): Promise<vscode.WorkspaceEdit | undefined> {
			const line = document.lineAt(position.line).text;
			const tag = findTagAtPosition(line, position.character);
			if (!tag) return undefined;

			const oldKey = tag.key;
			if (oldKey === newName) return undefined;

			const edit = new vscode.WorkspaceEdit();
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

			const rootPath = workspaceFolders[0].uri.fsPath;

			// 1. Update all .ree files in the workspace
			const reeFiles = await vscode.workspace.findFiles('**/*.ree', '**/node_modules/**');
			const reeKeyRe = new RegExp(
				`(\\{[_-]\\s+)${escapeRegex(oldKey)}(\\s*\\})`,
				'g'
			);

			for (const file of reeFiles) {
				try {
					const content = fs.readFileSync(file.fsPath, 'utf-8');
					reeKeyRe.lastIndex = 0;
					if (!reeKeyRe.test(content)) continue;

					reeKeyRe.lastIndex = 0;
					const newContent = content.replace(reeKeyRe, `$1${newName}$2`);

					if (newContent !== content) {
						const lines = content.split('\n');
						const fullRange = new vscode.Range(
							new vscode.Position(0, 0),
							new vscode.Position(lines.length, 0)
						);
						edit.replace(file, fullRange, newContent);
					}
				} catch {
					continue;
				}
			}

			// 2. Update locale JSON files using parse-modify-serialize
			const translationDirs = findTranslationDirs(rootPath);

			for (const dir of translationDirs) {
				const files = fs.readdirSync(dir).filter(f =>
					/^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)
				);

				for (const file of files) {
					const filePath = path.join(dir, file);
					const uri = vscode.Uri.file(filePath);

					try {
						const content = fs.readFileSync(filePath, 'utf-8');
						const parsed = JSON.parse(content) as Record<string, unknown>;

						// Use a fresh copy of the path for each file
						const pathParts = oldKey.split('.');
						const lastPart = pathParts.pop()!;
						const parent = navigateTo(parsed, pathParts);
						if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
							continue;
						}

						const parentObj = parent as Record<string, unknown>;
						if (!(lastPart in parentObj)) {
							continue; // Key doesn't exist in this file, skip
						}

						// Rename the key in the in-memory object
						const value = parentObj[lastPart];
						delete parentObj[lastPart];

						const newLastPart = newName.split('.').pop()!;
						parentObj[newLastPart] = value;

						// Serialize back to JSON (2-space indentation)
						const newContent = JSON.stringify(parsed, null, 2) + '\n';
						const lines = content.split('\n');
						const fullRange = new vscode.Range(
							new vscode.Position(0, 0),
							new vscode.Position(lines.length, 0)
						);
						edit.replace(uri, fullRange, newContent);
					} catch {
						continue;
					}
				}
			}

			return edit;
		},
	};
}

/**
 * Navigate into a parsed JSON object following a dot-path.
 * Returns the parent object for the given path segments.
 */
function navigateTo(obj: Record<string, unknown>, parts: string[]): unknown {
	let current: unknown = obj;
	for (const part of parts) {
		if (current && typeof current === 'object' && !Array.isArray(current)) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return current;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
