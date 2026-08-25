import * as fs from 'fs';
import * as path from 'path';
import { is_locale_file } from './locale_file';

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

/** Cache keyed by the ordered ancestor chain (root first, template dir last). */
const cache = new Map<string, CacheEntry>();

function chain_key(chain: string[]): string {
	return chain.join('\x00');
}

function latest_mtime_in(dirs: string[]): number {
	try {
		let max = 0;
		for (const localeDir of dirs) {
			if (!fs.existsSync(localeDir)) continue;
			const files = fs.readdirSync(localeDir).filter(is_locale_file);
			for (const file of files) {
				const mtime = fs.statSync(path.join(localeDir, file)).mtimeMs;
				if (mtime > max) max = mtime;
			}
		}
		return max;
	} catch {
		return Date.now();
	}
}

export function getCached(chain: string[]): TranslationCache | null {
	const key = chain_key(chain);
	const entry = cache.get(key);
	if (!entry) return null;

	// Build the same directory list the loader would scan: each ancestor's
	// directory and its `locales/` subfolder.
	const dirs: string[] = [];
	for (const anc of chain) {
		const nested = path.join(anc, 'locales');
		if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
			dirs.push(nested);
		} else {
			dirs.push(anc);
		}
	}

	const mtime = latest_mtime_in(dirs);
	if (mtime > entry.mtimeMs) {
		cache.delete(key);
		return null;
	}

	return entry.data;
}

export function setCached(chain: string[], data: TranslationCache): void {
	const dirs: string[] = [];
	for (const anc of chain) {
		const nested = path.join(anc, 'locales');
		if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
			dirs.push(nested);
		} else {
			dirs.push(anc);
		}
	}
	const mtimeMs = latest_mtime_in(dirs);
	cache.set(chain_key(chain), { data, mtimeMs });
}

export function clearCache(dir?: string): void {
	if (dir) {
		for (const [key, _] of cache) {
			if (key.includes(dir)) cache.delete(key);
		}
	} else {
		cache.clear();
	}
}
