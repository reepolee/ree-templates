/**
 * reepolee-dev project profile.
 *
 * Conventions:
 * - Routes live in `routes/` (standard module-based routing)
 * - Components live in `components/` (hyphenated .ree files)
 * - Translations are co-located JSON: a project-level root plus per-route
 *   overrides, each either a bare directory or a `locales/` subfolder
 * - Helper names & include resolver imported at runtime from the project
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

import type { ReeProjectProfile, ResolvedTarget } from "./index";
import { is_locale_file, resolve_template_file, within_base, flatten_json } from "./index";
import { DEFAULT_HELPER_NAMES } from "./helper_loader";
import { local_resolve } from "./include_loader";
import type { ReeProjectConfig } from "./project_config";

/** Conventional subfolder holding locale JSON files. */
const LOCALES_DIR = "locales";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function create_reepolee_profile(project_root: string, config: ReeProjectConfig): Promise<ReeProjectProfile> {
	const route_roots = config.template_roots.map((template_root) => join(project_root, template_root));
	const component_roots = config.component_roots.map((component_root) => join(project_root, component_root));
	const translation_roots = config.translation_roots.map((root) => join(project_root, root));
	const views_dir = route_roots[0]!;
	const components_dir = component_roots[0]!;

	return {
		project_root,
		name: "reepolee",
		label: "Reepolee",
		route_roots,
		component_roots,
		translation_roots,
		helper_names: DEFAULT_HELPER_NAMES,

		resolve_include(path_value: string, from_file: string): ResolvedTarget | undefined {
			return local_resolve(path_value, from_file, views_dir);
		},

		resolve_component(tag_name: string): ResolvedTarget | undefined {
			const file_path = resolve_template_file(join(components_dir, tag_name));
			if (!file_path) return undefined;
			const safe = within_base(file_path, components_dir);
			if (!safe) return undefined;
			return { kind: "template", file_path: safe, template_name: `components/${tag_name}` };
		},

		load_translation_index(locale_file: string, from_ree_file?: string): Map<string, string> | null {
			return load_co_located_translations(locale_file, project_root, from_ree_file);
		},

		translation_definition_files(from_ree_file: string): string[] {
			return definition_files(project_root, from_ree_file);
		},
	};
}

// ---------------------------------------------------------------------------
// Co-located locale directories
// ---------------------------------------------------------------------------

/**
 * Locale files sit either directly in a directory or in its `locales/`
 * subfolder. Returns whichever exists, preferring the subfolder.
 */
function locale_dir_for(dir: string): string | undefined {
	const nested = join(dir, LOCALES_DIR);
	if (existsSync(nested)) return nested;
	if (existsSync(dir)) return dir;
	return undefined;
}

/**
 * Ordered locale directories for a template, least to most specific:
 * the project root, then each ancestor directory down to the template's own.
 *
 * A template in `routes_reeman/project/` therefore inherits from
 * `locales/`, then `routes_reeman/locales/`, then `routes_reeman/project/locales/`.
 */
function locale_dirs_for(project_root: string, from_ree_file?: string): string[] {
	const dirs: string[] = [];

	const root_dir = locale_dir_for(join(project_root, LOCALES_DIR));
	if (root_dir) dirs.push(root_dir);

	if (from_ree_file) {
		const chain: string[] = [];
		let dir = dirname(from_ree_file);

		while (within_base(dir, project_root) && dir !== project_root) {
			chain.unshift(dir);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		for (const ancestor of chain) {
			const locale_dir = locale_dir_for(ancestor);
			if (locale_dir && !dirs.includes(locale_dir)) dirs.push(locale_dir);
		}
	}

	return dirs;
}

function locale_files_in(dir: string): string[] {
	try {
		const files = readdirSync(dir).filter(is_locale_file);
		files.sort();
		return files.map((file_name) => join(dir, file_name));
	} catch {
		return [];
	}
}

/** Route-local files are listed first so go-to-definition lands on overrides. */
function definition_files(project_root: string, from_ree_file: string): string[] {
	const dirs = locale_dirs_for(project_root, from_ree_file);
	const reversed = [...dirs].reverse();
	const out: string[] = [];
	for (const dir of reversed) {
		out.push(...locale_files_in(dir));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Translation index loading (co-located JSON)
// ---------------------------------------------------------------------------

/**
 * Load translations for a template as a flat key -> value map.
 *
 * The project root supplies shared strings and the template's own directory
 * deep-merges over them, so `{_ ui.title }` picks up a route-local override
 * while still resolving keys that only exist at the root.
 */
function load_co_located_translations(locale_file: string, project_root: string, from_ree_file?: string): Map<string, string> | null {
	const locale_name = basename(locale_file);
	const dirs = locale_dirs_for(project_root, from_ree_file);

	let merged: Record<string, unknown> | null = null;

	for (const dir of dirs) {
		const candidate = join(dir, locale_name);
		if (!existsSync(candidate)) continue;
		const data = read_json_object(candidate);
		if (!data) continue;
		merged = merged ? deep_merge(merged, data) : data;
	}

	if (!merged) return null;

	const map = new Map<string, string>();
	flatten_json(merged, "", map);
	return map;
}

function read_json_object(file_path: string): Record<string, unknown> | null {
	try {
		const content = readFileSync(file_path, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		return is_obj(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function is_obj(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deep_merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out = { ...a };
	for (const k of Object.keys(b)) {
		if (is_obj(b[k]) && is_obj(out[k])) {
			out[k] = deep_merge(out[k] as Record<string, unknown>, b[k] as Record<string, unknown>);
		} else {
			out[k] = b[k];
		}
	}
	return out;
}
