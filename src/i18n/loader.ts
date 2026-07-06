import * as fs from 'fs';
import * as path from 'path';

import { getCached, setCached } from './cache';
import type { TranslationCache } from './cache';
import { flatten } from './flatten';

/**
 * Pattern matches locale JSON files: "en.json", "sl.json", "en-US.json", "zh-CN.json", etc.
 */
const LOCALE_FILE_RE = /^[a-z]{2}(-[A-Z]{2})?\.json$/;

/**
 * Given the file path of a .ree template, find all translation files
 * in the same directory and return flattened translation data keyed by locale.
 *
 * Returns `null` if no translation files exist in the directory.
 */
export function loadTranslations(reeFilePath: string): TranslationCache | null {
	const dir = path.dirname(reeFilePath);

	// Check cache first
	const cached = getCached(dir);
	if (cached) return cached;

	// Find locale JSON files in the same directory
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(f => LOCALE_FILE_RE.test(f));
	} catch {
		return null;
	}

	if (files.length === 0) return null;

	const result: TranslationCache = {};

	for (const file of files) {
		const locale = file.replace(/\.json$/, '');
		const filePath = path.join(dir, file);

		try {
			const content = fs.readFileSync(filePath, 'utf-8');
			const parsed = JSON.parse(content) as Record<string, unknown>;
			result[locale] = flatten(parsed);
		} catch {
			// Skip unreadable or invalid JSON files
			continue;
		}
	}

	if (Object.keys(result).length === 0) return null;

	setCached(dir, result);
	return result;
}

/**
 * Find all directories that contain translation JSON files within a workspace.
 * Used by rename provider to find all translation files across the project.
 */
export function findTranslationDirs(
	workspaceRoot: string
): string[] {
	const dirs: string[] = [];

	function walk(dir: string) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const hasLocaleJson = entries.some(
				e => e.isFile() && LOCALE_FILE_RE.test(e.name)
			);
			if (hasLocaleJson) {
				dirs.push(dir);
			}
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
					walk(path.join(dir, entry.name));
				}
			}
		} catch {
			// Skip inaccessible directories
		}
	}

	walk(workspaceRoot);
	return dirs;
}

/**
 * Get the full list of translation keys available for a given .ree file.
 */
export function getTranslationKeys(reeFilePath: string): string[] | null {
	const data = loadTranslations(reeFilePath);
	if (!data) return null;

	// Collect all keys across all locales
	const keySet = new Set<string>();
	for (const localeData of Object.values(data)) {
		for (const key of Object.keys(localeData)) {
			keySet.add(key);
		}
	}

	return Array.from(keySet).sort();
}
