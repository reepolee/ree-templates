import * as vscode from "vscode";

import { get_env_var_description_via_lsp } from "./lsp_client";

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_VAR_ACCESS_RE = /(?:^|[^A-Za-z0-9_$])(?:Bun|process)\.env\.(?<name>[A-Za-z_$][\w$]*)/g;
const ENV_VAR_BRACKET_ACCESS_RE = /(?:^|[^A-Za-z0-9_$])(?:Bun|process)\.env\[(?<quote>["'`])(?<name>[A-Za-z_$][\w$]*)\k<quote>\]/g;
const REQUIRE_ENV_DECLARATION_RE = /\b(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*require_env\(\s*(?<quote>["'`])\k<name>\k<quote>/g;
const REQUIRE_ENV_ACCESS_RE = /(?:^|[^A-Za-z0-9_$])require_env\(\s*(?<quote>["'`])(?<name>[A-Za-z_$][\w$]*)\k<quote>/g;
const CODE_LANGUAGES = ["javascript", "javascriptreact", "typescript", "typescriptreact"];

export function create_env_var_hover_provider(): vscode.Disposable {
	return vscode.languages.registerHoverProvider(
		CODE_LANGUAGES.map((language) => ({ language })),
		{
			provideHover(document: vscode.TextDocument, position: vscode.Position): Thenable<vscode.Hover | undefined> {
				const reference = env_var_reference_at(document.getText(), document.offsetAt(position));
				if (!reference) return Promise.resolve(undefined);

				return get_env_var_description_via_lsp(document.uri.toString(), reference.name).then((description) => {
					if (!description) return undefined;
					const markdown = new vscode.MarkdownString(
						`**Environment variable** \`${reference.name}\`\n\n${description}`,
					);
					return new vscode.Hover(markdown, new vscode.Range(
						document.positionAt(reference.start),
						document.positionAt(reference.end),
					));
				});
			},
		},
	);
}

export function env_var_reference_at(text: string, offset: number): { name: string; start: number; end: number } | undefined {
	for (const access_pattern of [ENV_VAR_ACCESS_RE, ENV_VAR_BRACKET_ACCESS_RE, REQUIRE_ENV_DECLARATION_RE, REQUIRE_ENV_ACCESS_RE]) {
		for (const match of text.matchAll(access_pattern)) {
			const name = match.groups?.name;
			const match_start = match.index ?? -1;
			if (!name || match_start < 0) continue;

			const name_offsets = access_pattern === REQUIRE_ENV_DECLARATION_RE
				? [match[0].indexOf(name), match[0].lastIndexOf(name)]
				: [match[0].lastIndexOf(name)];
			for (const name_offset of name_offsets) {
				const name_start = match_start + name_offset;
				const name_end = name_start + name.length;
				if (offset < name_start || offset > name_end) continue;
			if (!ENV_VAR_NAME_RE.test(name)) return undefined;
				return { name, start: name_start, end: name_end };
			}
		}
	}

	return undefined;
}
