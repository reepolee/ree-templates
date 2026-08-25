import * as fs from 'fs';
import * as path from 'path';

import { getCached, setCached } from './cache';
import type { TranslationCache } from './cache';
import { flatten } from './flatten';
import { is_locale_file } from './locale_file';

/**
 * Given the file path of a .ree template, return flattened translation data
 * keyed by locale.
 *
 * Walks up from the template's directory through ancestor directories,
 * collecting BCP 47 locale JSON files (`en-US.json`, `sl-SI.json`).
 * At each directory, both the directory itself and its `locales/` subfolder
 * are checked; deeper directories override ancestor directories per locale.
 * This mirrors the route shadow chain that the LSP's profile-aware resolver
 * handles when the language server is available.
 *
 * Returns `null` if no locale files are found anywhere in the chain.
 */
export function loadTranslations(reeFilePath: string): TranslationCache | null {
	const dir = path.dirname(reeFilePath);

	// Build ancestor directory chain from the template's directory up to (and
	// including) the project root, so shared root locales are included. Stops
	// at the root - never walks above it.
	const root = findProjectRoot(dir) || dir;
	const chain: string[] = [];
	let current = dir;
	while (true) {
		chain.unshift(current);
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	// Check cache first (keyed by the ordered chain, sharing results across
	// any template whose locale-priority walk produces the same directories).
	let cached: TranslationCache | null;
	try { cached = getCached(chain); } catch { cached = null; }
	if (cached) return cached;

	// At each ancestor level, locale files may sit directly in the directory
	// or in a `locales/` subfolder. Prefer the subfolder (it's the convention
	// for reepolee route-local overrides).
	const dirs: string[] = [];
	for (const anc of chain) {
		const nested = path.join(anc, 'locales');
		if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
			dirs.push(nested);
			continue;
		}
		dirs.push(anc);
	}

	const result: TranslationCache = {};

	for (const localeDir of dirs) {
		let files: string[];
		try {
			files = fs.readdirSync(localeDir).filter(is_locale_file);
		} catch {
			continue;
		}

		for (const file of files) {
			const locale = file.replace(/\.json$/, '');
			const filePath = path.join(localeDir, file);

			try {
				const content = fs.readFileSync(filePath, 'utf-8');
				const parsed = JSON.parse(content) as Record<string, unknown>;
				// Merge: deeper directories override ancestor keys for the same locale.
				const flat = flatten(parsed);
				result[locale] = result[locale]
					? { ...result[locale], ...flat }
					: flat;
			} catch {
				// Skip unreadable or invalid JSON files
				continue;
			}
		}
	}

	if (Object.keys(result).length === 0) return null;

	setCached(chain, result);
	return result;
}

/**
 * Walk up from a directory to find the project root (marked by .git or
 * package.json). Returns undefined when neither marker is found.
 */
function findProjectRoot(dir: string): string | undefined {
	let current = dir;
	while (true) {
		if (fs.existsSync(path.join(current, '.git'))) return current;
		if (fs.existsSync(path.join(current, 'package.json'))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
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
				e => e.isFile() && is_locale_file(e.name)
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
