import * as vscode from 'vscode';
import { get_translations_via_lsp } from '../lsp_client';
import { loadTranslations } from './loader';
import { get_default_locale } from './settings';

/**
 * Regex matching translation tags.
 */
const TRANSLATION_TAG_RE = /\{[_@-]\s+([\w.]+)\s*\}/g;

/**
 * Creates and manages inline decorations that show translated values
 * as ghost text after translation tags.
 *
 * Works like i18n ally - you see `{_ hero.title } → Welcome` in the editor.
 *
 * Uses the LSP's profile-aware translation resolver when available
 * (which handles route-shadowed locale chains), falling back to the
 * local co-located loader for editors that predate the LSP connection.
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

	async function update() {
		const default_locale = get_default_locale();

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.languageId !== 'ree') continue;

			const text = editor.document.getText();

			// Try the LSP first (handles route-shadowed locale chains),
			// fall back to the local co-located loader.
			const translations =
				(await get_translations_via_lsp(editor.document.uri.toString())) ??
				loadTranslations(editor.document.fileName);

			if (!translations) {
				editor.setDecorations(decorationType, []);
				continue;
			}

			// Use the configured locale, fall back to first available.
			// Locale keys from files are lowercase (en-us) but the VS Code
			// setting uses proper BCP 47 casing (en-US); normalize both.
			const target = default_locale.toLowerCase();
			let display_data = translations[default_locale];
			if (!display_data) {
				for (const [key, value] of Object.entries(translations)) {
					if (key.toLowerCase() === target) {
						display_data = value;
						break;
					}
				}
			}
			if (!display_data) {
				display_data = Object.values(translations)[0];
			}
			if (!display_data) {
				editor.setDecorations(decorationType, []);
				continue;
			}

			const decorations: vscode.DecorationOptions[] = [];
			let match: RegExpExecArray | null;
			TRANSLATION_TAG_RE.lastIndex = 0;

			while ((match = TRANSLATION_TAG_RE.exec(text)) !== null) {
				const key = match[1];
				const value = display_data[key];

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
