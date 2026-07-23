import * as fs from 'fs';
import * as path from 'path';

import { getCached, setCached, getCachedDb, setCachedDb } from './cache';
import type { TranslationCache } from './cache';
import { flatten } from './flatten';

/**
 * Pattern matches locale JSON files: "en.json", "sl.json", "en-US.json", "zh-CN.json", etc.
 */
const LOCALE_FILE_RE = /^[a-z]{2}(-[A-Z]{2})?\.json$/;

/**
 * Given the file path of a .ree template, return flattened translation data
 * keyed by locale.
 *
 * Two sources are supported, tried in order:
 *  1. ree-web style: locale JSON files (`en.json`, `sl.json`) co-located in the
 *     same directory as the .ree file.
 *  2. reepolee-dev style ("DB mode"): a `.reepolee/i18n/<lang>.json` working
 *     folder emitted by the dev server from the DB `translations` table. Keys
 *     are resolved for the file's route namespace (see `loadDbTranslations`).
 *
 * Returns `null` if neither source is available.
 */
export function loadTranslations(reeFilePath: string): TranslationCache | null {
	const siblings = loadSiblingTranslations(reeFilePath);
	if (siblings) return siblings;

	return loadDbTranslations(reeFilePath);
}

/**
 * ree-web style: read locale JSON files co-located with the .ree file.
 */
function loadSiblingTranslations(reeFilePath: string): TranslationCache | null {
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
 * Locate the nearest ancestor `.reepolee/i18n` directory for a .ree file.
 * Its presence marks a reepolee-dev project whose translations come from the DB.
 * Returns the directory path, or `null` if none is found up to the filesystem root.
 */
export function findReepoleeI18nDir(reeFilePath: string): string | null {
	let dir = path.dirname(reeFilePath);

	// Walk up until we hit the filesystem root
	while (true) {
		const candidate = path.join(dir, '.reepolee', 'i18n');
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Not here - keep climbing
		}

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * True when the .ree file belongs to a reepolee-dev project (DB-backed
 * translations emitted to `.reepolee/i18n`). Consumers that write translation
 * JSONs (rename, "create key" quick-fix) must disable those actions in this
 * mode - the DB is the source of truth, not files under `routes/`.
 */
export function isDbTranslationMode(reeFilePath: string): boolean {
	return findReepoleeI18nDir(reeFilePath) !== null;
}

/**
 * reepolee-dev style: resolve translations from `.reepolee/i18n/<lang>.json`.
 *
 * Each file holds the full per-language tree. For a given .ree file we mirror
 * the server's per-request resolution (`resolve_translations` in
 * reepolee-dev/lib/request_context.ts): merge the root `routes.*` namespace
 * with the subtree at the file's route namespace, then flatten. This yields
 * exactly the keys that resolve at runtime for that template.
 */
function loadDbTranslations(reeFilePath: string): TranslationCache | null {
	const i18nDir = findReepoleeI18nDir(reeFilePath);
	if (!i18nDir) return null;

	const namespace = routeNamespaceFromPath(reeFilePath);
	const cacheKey = `db:${i18nDir}:${namespace}`;

	const cached = getCachedDb(cacheKey, i18nDir);
	if (cached) return cached;

	let files: string[];
	try {
		files = fs.readdirSync(i18nDir).filter(f => LOCALE_FILE_RE.test(f));
	} catch {
		return null;
	}

	if (files.length === 0) return null;

	const result: TranslationCache = {};

	for (const file of files) {
		const locale = file.replace(/\.json$/, '');
		const filePath = path.join(i18nDir, file);

		try {
			const content = fs.readFileSync(filePath, 'utf-8');
			const tree = JSON.parse(content) as Record<string, unknown>;
			const merged = mergeRouteSubtree(tree, namespace);
			result[locale] = flatten(merged);
		} catch {
			// Skip unreadable or invalid JSON files
			continue;
		}
	}

	if (Object.keys(result).length === 0) return null;

	setCachedDb(cacheKey, i18nDir, result);
	return result;
}

/**
 * The route namespace for a .ree file: the directory relative to the nearest
 * `routes/` segment (e.g. ".../routes/examples/kitchen_sink/x.ree" ->
 * "examples/kitchen_sink"). Files not under `routes/` get "" (root only).
 * Mirrors `route_namespace_from_dir` in reepolee-dev/lib/route.ts.
 */
function routeNamespaceFromPath(reeFilePath: string): string {
	const dir = path.dirname(reeFilePath).replace(/\\/g, '/');
	const marker = '/routes/';
	const idx = dir.lastIndexOf(marker);
	if (idx === -1) return '';

	return dir.substring(idx + marker.length);
}

/**
 * Merge the root `routes.*` namespace with the subtree at `namespace`, the
 * subtree winning on conflicts. Mirrors `resolve_translations`.
 */
function mergeRouteSubtree(tree: Record<string, unknown>, namespace: string): Record<string, unknown> {
	const root = isPlainObject(tree.routes) ? tree.routes : {};
	const subtree = getNested(tree, namespace);
	return deepMerge(root, subtree);
}

/**
 * Resolve a dotted/slashed path into a nested object, returning the object at
 * that path or `{}`. Splits on both `.` and `/` like reepolee-dev's `get_nested`.
 */
function getNested(obj: Record<string, unknown>, pathStr: string): Record<string, unknown> {
	if (!pathStr) return {};

	const parts = pathStr.split(/[./]/).filter(Boolean);
	let current: unknown = obj;

	for (const part of parts) {
		if (!isPlainObject(current)) return {};
		current = current[part];
	}

	return isPlainObject(current) ? current : {};
}

/**
 * Deep-merge two plain objects. `source` wins on conflicts. Nested plain
 * objects are merged recursively; everything else is replaced. Does not mutate
 * either input.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...target };

	for (const key of Object.keys(source)) {
		const sourceVal = source[key];
		const targetVal = out[key];

		if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
			out[key] = deepMerge(targetVal, sourceVal);
		} else {
			out[key] = sourceVal;
		}
	}

	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
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
