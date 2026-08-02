import * as vscode from 'vscode';
import { get_default_locale, get_supported_locales, set_default_locale } from './settings';

/**
 * Creates a status bar item that shows the current translation locale.
 *
 * Clicking it opens a Quick Pick to switch between available locales
 * defined in config/supported_locales.ts.
 */
export function createLocaleStatusBarItem(): vscode.Disposable {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.command = 'ree.switchLocale';
	statusBarItem.tooltip = 'Click to switch translation display language';

	function update() {
		const locale = get_default_locale().toUpperCase();
		statusBarItem.text = `$(globe) REE: ${locale}`;
		statusBarItem.show();
	}

	// Update on configuration changes
	const configSub = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('ree.translation.defaultLocale')) {
			update();
			// Fire a custom event so inline decorations refresh
			vscode.commands.executeCommand('ree._refreshInline');
		}
	});

	// Command to switch locale
	const commandSub = vscode.commands.registerCommand('ree.switchLocale', async () => {
		const supported = get_supported_locales();
		const current = get_default_locale();

		const items = supported.codes.map(code => ({
			label: `${code.toUpperCase()} - ${supported.names[code] || code}`,
			description: code === current ? 'current' : '',
			code,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select display language for translations',
		});

		if (selected && selected.code !== current) {
			await set_default_locale(selected.code);
			update();
			vscode.commands.executeCommand('ree._refreshInline');
		}
	});

	update();

	return vscode.Disposable.from(statusBarItem, configSub, commandSub);
}
