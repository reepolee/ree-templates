import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Parsed locales from config/supported_locales.ts.
 */
export interface SupportedLocales {
	codes: string[];
	names: Record<string, string>;
	default_locale: string;
}

/**
 * Cache for parsed supported_locales data.
 */
let parsed_cache: { data: SupportedLocales; mtimeMs: number } | null = null;

/**
 * Find and parse config/supported_locales.ts from the workspace root.
 * Returns a list of available locale codes with display names.
 */
export function get_supported_locales(): SupportedLocales {
	const fallback: SupportedLocales = {
		codes: ['en-US'],
		names: { 'en-US': 'English' },
		default_locale: 'en-US',
	};

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) return fallback;

	const config_path = path.join(workspaceFolders[0].uri.fsPath, 'config', 'supported_locales.ts');

	try {
		const stat = fs.statSync(config_path);
		if (parsed_cache && stat.mtimeMs <= parsed_cache.mtimeMs) {
			return parsed_cache.data;
		}

		const content = fs.readFileSync(config_path, 'utf-8');
		const data = parse_supported_locales(content);
		parsed_cache = { data, mtimeMs: stat.mtimeMs };
		return data;
	} catch {
		return fallback;
	}
}

/**
 * Parse the config/supported_locales.ts file content using regex.
 * Expected exports:
 *   export const locales = ["en-US", "sl-SI"] as const;
 *   export const locale_names: Record<string, string> = { "en-US": "English", ... };
 *   export const default_locale = "en-US";
 */
export function parse_supported_locales(content: string): SupportedLocales {
	const codes = extract_string_array(content, /export\s+const\s+locales\s*=\s*\[([^\]]*)\]/);
	const names = extract_string_record(content, /export\s+const\s+locale_names[\s\S]*?=\s*\{([^}]*)\}/);
	const default_locale = extract_string_value(content, /export\s+const\s+default_locale\s*=\s*"([^"]+)"/);

	return {
		codes: codes.length > 0 ? codes : ['en-US'],
		names: Object.keys(names).length > 0 ? names : { 'en-US': 'English' },
		default_locale: default_locale || 'en-US',
	};
}

/**
 * Extract a string array like ["en-US", "sl-SI"] from a regex match.
 */
function extract_string_array(content: string, regex: RegExp): string[] {
	const match = content.match(regex);
	if (!match) return [];
	return match[1]
		.split(',')
		.map(s => s.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

/**
 * Extract a string record like { "en-US": "English", "sl-SI": "Slovenian" } from a regex match.
 */
function extract_string_record(content: string, regex: RegExp): Record<string, string> {
	const match = content.match(regex);
	if (!match) return {};

	const result: Record<string, string> = {};
	// Match key: "value" or key: 'value' pairs inside the braces
	const pair_re = /(?:"([^"]+)"|(\w+))\s*:\s*"([^"]*)"/g;
	let pairMatch: RegExpExecArray | null;
	while ((pairMatch = pair_re.exec(match[1])) !== null) {
		const key = pairMatch[1] ?? pairMatch[2];
		if (key) result[key] = pairMatch[3];
	}
	return result;
}

/**
 * Extract a single string value from an assignment like default_locale = "en-US".
 */
function extract_string_value(content: string, regex: RegExp): string | null {
	const match = content.match(regex);
	return match ? match[1] : null;
}

/**
 * Get the configured default locale from VS Code settings.
 * Falls back to the project's default_locale or "en-US".
 */
export function get_default_locale(): string {
	const configured = vscode.workspace
		.getConfiguration('ree')
		.get<string>('translation.defaultLocale');
	if (configured) return configured;

	const supported = get_supported_locales();
	return supported.default_locale;
}

/**
 * Set the default locale in VS Code settings.
 */
export async function set_default_locale(locale: string): Promise<void> {
	await vscode.workspace
		.getConfiguration('ree')
		.update('translation.defaultLocale', locale, vscode.ConfigurationTarget.Global);
}
