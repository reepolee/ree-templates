import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Parsed languages from config/supported_languages.ts
 */
export interface SupportedLanguages {
	codes: string[];
	names: Record<string, string>;
	defaultLanguage: string;
}

/**
 * Cache for parsed supported_languages data.
 */
let parsedCache: { data: SupportedLanguages; mtimeMs: number } | null = null;

/**
 * Find and parse config/supported_languages.ts from the workspace root.
 * Returns a list of available locale codes with display names.
 */
export function getSupportedLanguages(): SupportedLanguages {
	const fallback: SupportedLanguages = {
		codes: ['en'],
		names: { en: 'English' },
		defaultLanguage: 'en',
	};

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) return fallback;

	const configPath = path.join(workspaceFolders[0].uri.fsPath, 'config', 'supported_languages.ts');

	try {
		const stat = fs.statSync(configPath);
		if (parsedCache && stat.mtimeMs <= parsedCache.mtimeMs) {
			return parsedCache.data;
		}

		const content = fs.readFileSync(configPath, 'utf-8');
		const data = parseSupportedLanguages(content);
		parsedCache = { data, mtimeMs: stat.mtimeMs };
		return data;
	} catch {
		return fallback;
	}
}

/**
 * Parse the config/supported_languages.ts file content using regex.
 * Expected exports:
 *   export const languages = ["en", "sl"] as const;
 *   export const language_names: Record<string, string> = { en: "English", ... };
 *   export const default_language = "en";
 */
function parseSupportedLanguages(content: string): SupportedLanguages {
	const codes = extractStringArray(content, /export\s+const\s+languages\s*=\s*\[([^\]]*)\]/);
	const names = extractStringRecord(content, /export\s+const\s+language_names[\s\S]*?=\s*\{([^}]*)\}/);
	const defaultLang = extractStringValue(content, /export\s+const\s+default_language\s*=\s*"([^"]+)"/);

	return {
		codes: codes.length > 0 ? codes : ['en'],
		names: Object.keys(names).length > 0 ? names : { en: 'English' },
		defaultLanguage: defaultLang || 'en',
	};
}

/**
 * Extract a string array like ["en", "sl"] from a regex match.
 */
function extractStringArray(content: string, regex: RegExp): string[] {
	const match = content.match(regex);
	if (!match) return [];
	return match[1]
		.split(',')
		.map(s => s.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

/**
 * Extract a string record like { en: "English", sl: "Slovenian" } from a regex match.
 */
function extractStringRecord(content: string, regex: RegExp): Record<string, string> {
	const match = content.match(regex);
	if (!match) return {};

	const result: Record<string, string> = {};
	// Match key: "value" or key: 'value' pairs inside the braces
	const pairRe = /(\w+)\s*:\s*"([^"]*)"/g;
	let pairMatch: RegExpExecArray | null;
	while ((pairMatch = pairRe.exec(match[1])) !== null) {
		result[pairMatch[1]] = pairMatch[2];
	}
	return result;
}

/**
 * Extract a single string value from an assignment like default_language = "en".
 */
function extractStringValue(content: string, regex: RegExp): string | null {
	const match = content.match(regex);
	return match ? match[1] : null;
}

/**
 * Get the configured default locale from VS Code settings.
 * Falls back to the project's default_language or "en".
 */
export function getDefaultLocale(): string {
	const configured = vscode.workspace
		.getConfiguration('ree')
		.get<string>('translation.defaultLocale');
	if (configured) return configured;

	const supported = getSupportedLanguages();
	return supported.defaultLanguage;
}

/**
 * Set the default locale in VS Code settings.
 */
export async function setDefaultLocale(locale: string): Promise<void> {
	await vscode.workspace
		.getConfiguration('ree')
		.update('translation.defaultLocale', locale, vscode.ConfigurationTarget.WorkspaceFolder);
}
