import * as vscode from 'vscode';
import { loadTranslations } from './loader';
import { getDefaultLocale } from './settings';

/**
 * Regex matching translation tags.
 */
const TRANSLATION_TAG_RE = /\{[_@-]\s+([\w.]+)\s*\}/g;

/**
 * Creates and manages inline decorations that show translated values
 * as ghost text after translation tags.
 *
 * Works like i18n ally — you see `{_ hero.title } → Welcome` in the editor.
 */
export function createInlineDecorations(): vscode.Disposable & { refresh: () => void } {
	const decorationType = vscode.window.createTextEditorDecorationType({
		after: {
			margin: '0 0 0 0.5em',
			fontStyle: 'italic',
			color: new vscode.ThemeColor('editorGhostText.foreground'),
		},
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	let timer: ReturnType<typeof setTimeout> | undefined;

	function update() {
		const defaultLocale = getDefaultLocale();

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.languageId !== 'ree') continue;

			const text = editor.document.getText();
			const translations = loadTranslations(editor.document.fileName);
			if (!translations) {
				editor.setDecorations(decorationType, []);
				continue;
			}

			// Use the configured locale, fall back to first available
			const displayData = translations[defaultLocale] ?? Object.values(translations)[0];
			if (!displayData) {
				editor.setDecorations(decorationType, []);
				continue;
			}

			const decorations: vscode.DecorationOptions[] = [];
			let match: RegExpExecArray | null;
			TRANSLATION_TAG_RE.lastIndex = 0;

			while ((match = TRANSLATION_TAG_RE.exec(text)) !== null) {
				const key = match[1];
				const value = displayData[key];

				if (value !== undefined) {
					const range = new vscode.Range(
						editor.document.positionAt(match.index),
						editor.document.positionAt(match.index + match[0].length)
					);

					decorations.push({
						range,
						renderOptions: {
							after: {
								contentText: `→ ${value}`,
							},
						},
					});
				}
			}

			editor.setDecorations(decorationType, decorations);
		}
	}

	// Debounced update on text changes
	const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
		if (e.document.languageId !== 'ree') return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(update, 300);
	});

	// Immediate update on scroll / new editors
	const visibleSub = vscode.window.onDidChangeVisibleTextEditors(() => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(update, 100);
	});

	// Initial update
	update();

	const disposable = vscode.Disposable.from(
		decorationType,
		changeSub,
		visibleSub,
		{ dispose: () => { if (timer) clearTimeout(timer); } }
	);

	return Object.assign(disposable, { refresh: update });
}
