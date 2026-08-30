import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── LSP client ────────────────────────────────────────────────────────────

import { create_lsp_client, start_client, deactivate_client } from './lsp_client';

// ─── i18n (VS Code-specific features only) ─────────────────────────────────
// The LSP handles: hover, completion, definition, diagnostics, and code actions
// for translations. Client-side keeps only VS Code-specific rendering:
// inline decorations (→ value) and status bar (locale switcher).

import { createInlineDecorations } from './i18n/inline';
import { createLocaleStatusBarItem } from './i18n/statusBar';

// ─── ReeTag expansion (VS Code-specific, not duplicated by LSP) ────────────

import { find_ree_tag_at } from './expand/tag_parser';
import { resolve_component_path, read_component_source } from './expand/component_resolver';
import { inline_component } from './expand/inline_component';

// ─── FIXED: project root resolver (important change) ───────────────────────

function findProjectRoot(startDir: string): string {
	let dir = startDir;

	while (true) {
		// git fallback
		if (fs.existsSync(path.join(dir, '.git'))) return dir;

		const parent = path.dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return startDir;
}

// ─── formatter selection ────────────────────────────────────────────────────

// Resolve the executable command for reettier. When the path setting is empty
// we fall back to the bare name so PATH lookup applies.
function resolve_formatter_cmd(config: vscode.WorkspaceConfiguration): string {
	const reettier_path = config.get<string>('reettierPath', '');
	return reettier_path || 'reettier';
}

// ─── formatter discovery (version) ───────────────────────────────────────────

// Query the executable for its version via `--version`. Returns the trimmed
// first line, or null when the command is missing or errors out.
function query_version(cmd: string): Promise<string | null> {
	return new Promise(resolve => {
		let p;
		try {
			p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			resolve(null);
			return;
		}

		let out = '';
		p.stdout.on('data', d => (out += d.toString()));
		p.stderr.on('data', d => (out += d.toString()));

		p.on('error', () => resolve(null));

		p.on('close', code => {
			const first_line = out.trim().split(/\r?\n/)[0] || '';
			if (code === 0 && first_line) resolve(first_line);
			else resolve(first_line || null);
		});
	});
}

// Probe the real installed reettier CLI and return its version. We look it up
// by its own name (not the formatting path override) so a path shim does not
// mask the genuine version.
async function check_formatters(): Promise<string | null> {
	return query_version('reettier');
}

// ─── formatter runner (unchanged idea, just safer) ─────────────────────────

function run_formatter(cmd: string, cwd: string, input: string, extraArgs: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, ['--stdin', ...extraArgs], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let out = '';
		let err = '';

		p.stdout.on('data', d => (out += d.toString()));
		p.stderr.on('data', d => (err += d.toString()));

		p.on('close', code => {
			if (code === 0) resolve(out);
			else reject(new Error(err || `${cmd} failed (${code})`));
		});

		p.stdin.write(input);
		p.stdin.end();
	});
}

function run_command(cmd: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';

		p.stderr.on('data', d => (err += d.toString()));
		p.on('error', reject);
		p.on('close', code => {
			if (code === 0) resolve();
			else reject(new Error(err.trim() || `${cmd} failed (${code})`));
		});
	});
}

function document_extension(document: vscode.TextDocument): string {
	return path.extname(document.fileName).toLowerCase();
}

function is_ree_text_file(document: vscode.TextDocument): boolean {
	return ['.js', '.ts', '.css'].includes(document_extension(document));
}

function is_supported_cli_file(document: vscode.TextDocument): boolean {
	return is_ree_text_file(document) || document_extension(document) === '.sql';
}

function full_document_edit(document: vscode.TextDocument, text: string): vscode.TextEdit {
	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(document.getText().length),
	);
	return vscode.TextEdit.replace(fullRange, text);
}

async function format_sql_text(document: vscode.TextDocument, cwd: string, extra_args: string[] = []): Promise<string> {
	const temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ree-sql-'));
	const temp_file = path.join(temp_dir, path.basename(document.fileName));

	try {
		await fs.promises.writeFile(temp_file, document.getText(), 'utf8');
		await run_command('reesql', [...extra_args, temp_file], cwd);
		return await fs.promises.readFile(temp_file, 'utf8');
	} finally {
		await fs.promises.rm(temp_dir, { recursive: true, force: true });
	}
}

async function format_cli_document(document: vscode.TextDocument, extra_sql_args: string[] = []): Promise<string> {
	const cwd = findProjectRoot(path.dirname(document.fileName));
	if (document_extension(document) === '.sql') {
		return format_sql_text(document, cwd, extra_sql_args);
	}

	const config = vscode.workspace.getConfiguration('ree', document.uri);
	const cmd = resolve_formatter_cmd(config);
	return run_formatter(cmd, cwd, document.getText(), [document_extension(document)]);
}

async function format_sql_file(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const document = editor.document;
	if (document_extension(document) !== '.sql') return;

	try {
		const formatted = await format_cli_document(document, ['--unwrap-joins', '--remove-backticks']);
		if (formatted !== document.getText()) {
			await editor.edit(editBuilder => editBuilder.replace(
				new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				formatted,
			));
		}
	} catch (err: any) {
		vscode.window.showErrorMessage(`Formatting failed: ${err.message ?? err}`);
	}
}

async function format_on_save(event: vscode.TextDocumentWillSaveEvent): Promise<vscode.TextEdit[]> {
	const document = event.document;
	const config = vscode.workspace.getConfiguration('ree', document.uri);
	if (!config.get<boolean>('formatOnSave', false) || !is_supported_cli_file(document)) return [];

	try {
		const formatted = await format_cli_document(document);
		return formatted === document.getText() ? [] : [full_document_edit(document, formatted)];
	} catch (err: any) {
		vscode.window.showErrorMessage(`Formatting on save failed: ${err.message ?? err}`);
		return [];
	}
}

// ─── activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	console.log('ree-templates: activate() started');

	// ─── inline decorations (created first so the LSP start can refresh them) ─

	const inlineDecorations = createInlineDecorations();

	// ─── LSP CLIENT ────────────────────────────────────────────────────────

	try {
		const lsp_client = create_lsp_client(context);
		const start_promise = start_client(lsp_client, context);
		// Inline decorations were computed before the LSP was ready and used
		// the local fallback; once the server is running, recompute through the
		// profile-aware resolver so route-shadowed locales resolve correctly.
		start_promise.then(() => inlineDecorations.refresh());
		console.log('ree-templates: LSP client created and started');
	} catch (err: any) {
		console.error('ree-templates: LSP client creation failed:', err.message ?? err);
		vscode.window.showErrorMessage(`ree LSP failed to start: ${err.message ?? err}`);
	}

	// ─── commands ────────────────────────────────────────────────────────────

	const formatCommand = vscode.commands.registerCommand('ree.format', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.languageId === 'ree') {
			vscode.commands.executeCommand('editor.action.formatDocument');
		}
	});

	// ─── format with reprint (full AST re-derivation via reettier --full) ───

	const formatWithReprintCommand = vscode.commands.registerCommand('ree.formatWithReprint', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'ree') {
			return;
		}

		const document = editor.document;
		const config = vscode.workspace.getConfiguration('ree', document.uri);
		const cmd = resolve_formatter_cmd(config);
		const cwd = findProjectRoot(path.dirname(document.fileName));

		try {
			const formatted = await run_formatter(cmd, cwd, document.getText(), ['--full']);

			const fullRange = new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length)
			);

			await editor.edit(editBuilder => {
				editBuilder.replace(fullRange, formatted);
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(
				`${cmd} --full failed: ${err.message ?? err}`
			);
		}
	});

	const formatWithMarkupCommand = vscode.commands.registerCommand('ree.formatWithMarkup', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'ree') {
			return;
		}

		const width_text = await vscode.window.showInputBox({
			prompt: 'Markup wrap width',
			value: '100',
			validateInput: value => /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive number',
		});
		if (width_text === undefined) {
			return;
		}

		const document = editor.document;
		const config = vscode.workspace.getConfiguration('ree', document.uri);
		const cmd = resolve_formatter_cmd(config);
		const cwd = findProjectRoot(path.dirname(document.fileName));
		const selection = editor.selection;
		const source = selection.isEmpty ? document.getText() : document.getText(selection);

		try {
			const formatted = await run_formatter(cmd, cwd, source, [
				'--wrap-markup',
				'--wrap-width',
				width_text,
			]);

			await editor.edit(editBuilder => {
				const target = selection.isEmpty
					? new vscode.Range(
						document.positionAt(0),
						document.positionAt(document.getText().length),
					)
					: selection;
				editBuilder.replace(target, formatted);
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(
				`${cmd} --wrap-markup --wrap-width ${width_text} failed: ${err.message ?? err}`
			);
		}
	});

	const formatSqlFileCommand = vscode.commands.registerCommand('ree.formatSqlFile', format_sql_file);
	const formatOnSaveListener = vscode.workspace.onWillSaveTextDocument(event => {
		event.waitUntil(format_on_save(event));
	});

	// ─── expand ReeTag (replace call site with the component's own body) ───

	const expandReeTagCommand = vscode.commands.registerCommand('ree.expandReeTag', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'ree') {
			return;
		}

		const document = editor.document;
		const source = document.getText();
		const offset = document.offsetAt(editor.selection.active);

		const tag = find_ree_tag_at(source, offset);
		if (!tag) {
			vscode.window.showErrorMessage('No ReeTag (custom-element with a hyphen) found at the cursor.');
			return;
		}

		const projectRoot = findProjectRoot(path.dirname(document.fileName));
		const componentPath = resolve_component_path(projectRoot, tag.tag_name);
		if (!componentPath) {
			vscode.window.showErrorMessage(
				`Could not find components/${tag.tag_name}.ree under ${projectRoot}.`
			);
			return;
		}

		const componentSource = read_component_source(componentPath);
		const inlined = inline_component(componentSource, tag);

		const startPos = document.positionAt(tag.start);
		const endPos = document.positionAt(tag.end);

		await editor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(startPos, endPos), inlined.trim());
		});
	});

	// ─── check formatters (installed versions) ───────────────────────────────

	const checkFormattersCommand = vscode.commands.registerCommand('ree.checkFormatters', async () => {
		const version = await check_formatters();
		const summary = version ? `reettier: ${version}` : 'reettier: not installed';
		const channel = vscode.window.createOutputChannel('ree Formatters');
		channel.clear();
		channel.appendLine(summary);
		channel.show(true);

		vscode.window.showInformationMessage(summary, { modal: false });
	});

	// ─── VS Code-specific i18n features (cannot be LSP) ─────────────────────
	// These use VS Code's TextEditorDecorationType API and status bar API,
	// which have no equivalent in the LSP protocol.

	// 1. Inline decorations — show → translated value after {_ / {- tags
	//    (created above, before the LSP starts)

	// 2. Status bar — language switcher
	const localeStatusBar = createLocaleStatusBarItem();

	// 3. Inline refresh command (called when locale changes via status bar)
	const refreshInlineCmd = vscode.commands.registerCommand('ree._refreshInline', () => {
		inlineDecorations.refresh();
	});

	// ─── push all subscriptions ─────────────────────────────────────────────

	context.subscriptions.push(
		formatCommand,
		formatWithReprintCommand,
		formatWithMarkupCommand,
		formatSqlFileCommand,
		formatOnSaveListener,
		expandReeTagCommand,
		checkFormattersCommand,

		// i18n (VS Code-specific only)
		inlineDecorations,
		localeStatusBar,
		refreshInlineCmd,
	);
}

export function deactivate() {
	return deactivate_client();
}
