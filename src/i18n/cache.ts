import * as fs from 'fs';
import * as path from 'path';

/**
 * Flattened translation data per locale.
 * Keys are dot-notation paths like "hero.title" -> "Welcome".
 */
export interface TranslationCache {
	[locale: string]: Record<string, string>;
}

interface CacheEntry {
	data: TranslationCache;
	mtimeMs: number;
}

/**
 * Cache keyed by directory path.
 * Each entry holds flattened translations for all locales found in that dir.
 */
const cache = new Map<string, CacheEntry>();

export function getCached(dir: string): TranslationCache | null {
	const entry = cache.get(dir);
	if (!entry) return null;

	// Re-validate by checking if any translation file in the dir has changed
	const dirExists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	if (!dirExists) {
		cache.delete(dir);
		return null;
	}

	try {
		const files = fs.readdirSync(dir).filter(f => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));

		for (const file of files) {
			const stat = fs.statSync(path.join(dir, file));
			if (stat.mtimeMs > entry.mtimeMs) {
				// Stale entry
				cache.delete(dir);
				return null;
			}
		}
	} catch {
		cache.delete(dir);
		return null;
	}

	return entry.data;
}

export function setCached(dir: string, data: TranslationCache): void {
	try {
		const files = fs.readdirSync(dir).filter(f => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));
		const mtimeMs = Math.max(
			0,
			...files.map(f => fs.statSync(path.join(dir, f)).mtimeMs)
		);
		cache.set(dir, { data, mtimeMs });
	} catch {
		cache.set(dir, { data, mtimeMs: Date.now() });
	}
}

export function clearCache(dir?: string): void {
	if (dir) {
		cache.delete(dir);
	} else {
		cache.clear();
	}
}
