import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
	const formatter = vscode.languages.registerDocumentFormattingEditProvider('ree', {
		async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
			const config = vscode.workspace.getConfiguration('ree');
			const customPath = config.get<string>('reefmtPath', '');
			const cmd = customPath || 'reefmt';

			try {
				const { stdout } = await execFileP(cmd, [document.fileName], { timeout: 15000 });
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);
				return [vscode.TextEdit.replace(fullRange, stdout)];
			} catch (err: any) {
				if (err.code === 'ENOENT') {
					vscode.window.showWarningMessage(
						'reefmt not found. Install reefmt or set "ree.reefmtPath" to the executable path.',
					);
				} else {
					const detail = err.stderr ?? err.message ?? String(err);
					vscode.window.showErrorMessage(`reefmt failed: ${detail}`);
				}
				return [];
			}
		},
	});

	const formatCommand = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	context.subscriptions.push(formatter, formatCommand);
}

export function deactivate() {}
