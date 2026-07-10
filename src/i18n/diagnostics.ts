import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { loadTranslations, getTranslationKeys } from './loader';

/**
 * Regex that matches translation tags.
 */
const TRANSLATION_TAG_RE = /\{[_@-]\s+([\w.]+)\s*\}/g;

const DIAGNOSTIC_CODE = 'ree-i18n-unknown-key';
const DIAGNOSTIC_SOURCE = 'ree-i18n';

/**
 * Creates a diagnostic collection and file watcher for translation key diagnostics.
 *
 * Underlines translation keys that don't exist in any of the locale JSON files.
 */
export function createTranslationDiagnostics(): {
	collection: vscode.DiagnosticCollection;
	watcher: vscode.FileSystemWatcher;
	updateDocument: (doc: vscode.TextDocument) => void;
} {
	const collection = vscode.languages.createDiagnosticCollection('ree-i18n');

	function updateDocument(document: vscode.TextDocument) {
		if (document.languageId !== 'ree') return;

		const text = document.getText();
		const allKeys = getTranslationKeys(document.fileName);

		const diagnostics: vscode.Diagnostic[] = [];
		let match: RegExpExecArray | null;

		TRANSLATION_TAG_RE.lastIndex = 0;

		while ((match = TRANSLATION_TAG_RE.exec(text)) !== null) {
			const key = match[1];

			// If we have translation data but the key is missing, flag it
			if (allKeys !== null && !allKeys.includes(key)) {
				const range = new vscode.Range(
					document.positionAt(match.index),
					document.positionAt(match.index + match[0].length)
				);
				const diagnostic = new vscode.Diagnostic(
					range,
					`Unknown translation key: "${key}"`,
					vscode.DiagnosticSeverity.Warning
				);
				diagnostic.code = DIAGNOSTIC_CODE;
				diagnostic.source = DIAGNOSTIC_SOURCE;
				diagnostics.push(diagnostic);
			}
		}

		collection.set(document.uri, diagnostics);
	}

	// Watch for translation JSON changes to re-diagnose
	const jsonPattern = new vscode.RelativePattern('**/*.json', '*');
	const watcher = vscode.workspace.createFileSystemWatcher(jsonPattern);

	watcher.onDidChange(() => {
		for (const editor of vscode.window.visibleTextEditors) {
			updateDocument(editor.document);
		}
	});
	watcher.onDidCreate(() => {
		for (const editor of vscode.window.visibleTextEditors) {
			updateDocument(editor.document);
		}
	});
	watcher.onDidDelete(() => {
		for (const editor of vscode.window.visibleTextEditors) {
			updateDocument(editor.document);
		}
	});

	return { collection, watcher, updateDocument };
}

/**
 * Code Action provider that offers Quick Fixes for unknown translation keys.
 * "Create key in en.json" / "Create key in sl.json"
 */
export function createTranslationCodeActionProvider(): vscode.CodeActionProvider {
	return {
		provideCodeActions(
			document: vscode.TextDocument,
			_range: vscode.Range,
			context: vscode.CodeActionContext
		): vscode.CodeAction[] {
			const actions: vscode.CodeAction[] = [];

			for (const diagnostic of context.diagnostics) {
				if (diagnostic.code !== DIAGNOSTIC_CODE) continue;

				const keyMatch = diagnostic.message.match(/"([\w.]+)"/);
				if (!keyMatch) continue;

				const key = keyMatch[1];
				const dir = path.dirname(document.fileName);

				// Find available locale files
				let localeFiles: string[];
				try {
					localeFiles = fs.readdirSync(dir).filter(f =>
						/^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)
					);
				} catch {
					localeFiles = [];
				}

				if (localeFiles.length === 0) {
					// No locale files exist — offer to create both en.json and sl.json
					const createBothAction = new vscode.CodeAction(
						'Create en.json and sl.json with this key',
						vscode.CodeActionKind.QuickFix
					);
					createBothAction.edit = new vscode.WorkspaceEdit();
					createBothAction.diagnostics = [diagnostic];
					createBothAction.isPreferred = false;

					const enUri = vscode.Uri.file(path.join(dir, 'en.json'));
					const enContent = buildNestedJson(key, '');
					createBothAction.edit.createFile(enUri, { ignoreIfExists: true });
					createBothAction.edit.insert(enUri, new vscode.Position(0, 0), enContent);

					const slUri = vscode.Uri.file(path.join(dir, 'sl.json'));
					const slContent = buildNestedJson(key, '');
					createBothAction.edit.createFile(slUri, { ignoreIfExists: true });
					createBothAction.edit.insert(slUri, new vscode.Position(0, 0), slContent);

					actions.push(createBothAction);
				} else {
					// One action per existing locale file
					for (const file of localeFiles) {
						const filePath = path.join(dir, file);
						const locale = file.replace(/\.json$/, '');

						const action = new vscode.CodeAction(
							`Create key "${key}" in ${file}`,
							vscode.CodeActionKind.QuickFix
						);
						action.edit = new vscode.WorkspaceEdit();
						action.diagnostics = [diagnostic];
						action.isPreferred = false;

					const uri = vscode.Uri.file(filePath);
					const edit = buildInsertEdit(uri, key, locale);
					if (edit) {
						action.edit.replace(uri, edit.range, edit.text);
						actions.push(action);
					}
					}
				}
			}

			return actions;
		},
	};
}

/**
 * Build a nested JSON object string for a dot-separated key.
 * e.g., "hero.title" -> '{\n  "hero": {\n    "title": ""\n  }\n}\n'
 */
function buildNestedJson(key: string, value: string): string {
	const parts = key.split('.');
	let indent = '';
	let json = '{\n';

	for (let i = 0; i < parts.length; i++) {
		indent += '  ';
		json += `${indent}"${parts[i]}": `;
		if (i === parts.length - 1) {
			json += `"${value}"`;
		} else {
			json += '{\n';
		}
	}
	for (let i = parts.length - 1; i >= 0; i--) {
		if (i === parts.length - 1) {
			json += '\n';
		}
		const dedent = '  '.repeat(i);
		json += `${dedent}}`;
		if (i > 0) json += ',';
		json += '\n';
	}

	return json;
}

/**
 * Build a replacement to insert a new key into an existing JSON file.
 * Uses parse-modify-serialize: reads the file, modifies the in-memory
 * object, then serializes back. Handles all value types without fragile
 * string-level parsing.
 */
function buildInsertEdit(
	uri: vscode.Uri,
	key: string,
	_locale: string
): { range: vscode.Range; text: string } | undefined {
	try {
		const content = fs.readFileSync(uri.fsPath, 'utf-8');
		const parsed = JSON.parse(content) as Record<string, unknown>;

		// Navigate through the parts to find the parent object,
		// creating intermediate objects as needed
		const parts = key.split('.');
		const lastPart = parts.pop()!;

		let current: unknown = parsed;
		for (const part of parts) {
			if (current && typeof current === 'object' && !Array.isArray(current)) {
				const obj = current as Record<string, unknown>;
				if (!(part in obj)) {
					obj[part] = {};
				}
				current = obj[part];
			} else {
				return undefined;
			}
		}

		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		const parent = current as Record<string, unknown>;
		if (parent[lastPart] !== undefined) return undefined; // Already exists

		parent[lastPart] = '';

		const newContent = JSON.stringify(parsed, null, 2) + '\n';
		const lastPos = positionAtEnd(content);
		return { range: new vscode.Range(new vscode.Position(0, 0), lastPos), text: newContent };
	} catch {
		return undefined;
	}
}

/**
 * Get the Position of the last character in a file's content.
 */
function positionAtEnd(content: string): vscode.Position {
	const lines = content.split('\n');
	return new vscode.Position(
		Math.max(0, lines.length - 1),
		lines[lines.length - 1].length
	);
}

