/**
 * reepolee-dev project profile.
 *
 * Conventions:
 * - Routes live in `routes/` (standard module-based routing)
 * - Any .ree file is usable as a ReeTag, named by its basename. Mirrors the
 *   component index built in lib/template/precompile.ts: `components/` wins
 *   outright, other roots fill gaps first-wins in root order.
 * - Translations are co-located JSON: a project-level root plus per-route
 *   overrides, each either a bare directory or a `locales/` subfolder
 * - Helper names & include resolver imported at runtime from the project
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";

import type { ReeProjectProfile, ResolvedTarget } from "./index";
import { is_locale_file, within_base, flatten_json, TEMPLATE_EXT } from "./index";
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

	return {
		project_root,
		name: "reepolee",
		label: "Reepolee",
		route_roots,
		component_roots,
		translation_roots,
		helper_names: DEFAULT_HELPER_NAMES,

		resolve_include(path_value: string, from_file: string): ResolvedTarget | undefined {
			// A template may live under any route root, so try each in order
			// and keep the first root that yields an existing file.
			for (const views_dir of route_roots) {
				const target = local_resolve(path_value, from_file, views_dir);
				if (target) return target;
			}
			return undefined;
		},

		resolve_component(tag_name: string): ResolvedTarget | undefined {
			const index = component_index(component_roots, route_roots);
			return index.get(tag_name);
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
// ReeTag component index
// ---------------------------------------------------------------------------

/** Locale-variant suffix on a template name, e.g. `card.sl-SI.ree`. */
const LOCALE_VARIANT_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i;

let index_cache: { key: string; index: Map<string, ResolvedTarget> } | null = null;

export function invalidate_component_index(): void {
	index_cache = null;
}

/**
 * Strip a trailing locale segment so `card.sl-SI` and `card` share one tag.
 * Mirrors split_locale() in lib/template/precompile.ts.
 */
function strip_locale_variant(name: string): string {
	const last_dot = name.lastIndexOf(".");
	if (last_dot > 0 && LOCALE_VARIANT_RE.test(name.slice(last_dot + 1))) {
		return name.slice(0, last_dot);
	}
	return name;
}

/** Every .ree file under a root, recursively. */
function scan_templates(root: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const full_path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			scan_templates(full_path, out);
		} else if (entry.name.endsWith(TEMPLATE_EXT)) {
			out.push(full_path);
		}
	}
}

/**
 * Template name relative to a root, without extension and locale variant.
 * Uses posix separators to match the runtime's include paths.
 */
function template_name_in(root: string, file_path: string): string {
	const rel = relative(root, file_path).split(sep).join("/");
	return strip_locale_variant(rel.slice(0, -TEMPLATE_EXT.length));
}

/**
 * Route module mounts declared by directory layout: any subdirectory of a
 * route root holding an `index.ts` is mounted under its own name. Mirrors
 * mount_route_modules_from_dir() in lib/route_module.ts, which is the only
 * way mounts are registered - reading the layout avoids executing project code.
 */
function module_mounts_in(root: string): { code: string; root: string }[] {
	const mounts: { code: string; root: string }[] = [];

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return mounts;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const module_root = join(root, entry.name);
		if (!existsSync(join(module_root, "index.ts"))) continue;
		mounts.push({ code: entry.name, root: module_root });
	}

	return mounts;
}

/**
 * Build a tag -> target index over every root.
 *
 * Component roots are applied last and overwrite unconditionally, so a shared
 * component shadows a same-named routes-tree file. Route roots fill gaps
 * first-wins, matching precompile.ts. Mounted modules name their templates
 * with the module code prefix, as the runtime does.
 */
function component_index(component_roots: string[], route_roots: string[]): Map<string, ResolvedTarget> {
	const cache_key = [...component_roots, "|", ...route_roots].join(";");
	if (index_cache && index_cache.key === cache_key) return index_cache.index;

	const index = new Map<string, ResolvedTarget>();

	const add = (file_path: string, template_name: string) => {
		const tag = strip_locale_variant(basename(file_path, TEMPLATE_EXT));
		if (index.has(tag)) return;
		index.set(tag, { kind: "template", file_path, template_name });
	};

	for (const root of route_roots) {
		const mounts = module_mounts_in(root);
		const files: string[] = [];
		scan_templates(root, files);

		for (const file_path of files) {
			const mount = mounts.find((candidate) => within_base(file_path, candidate.root));
			const name = mount
				? `${mount.code}/${template_name_in(mount.root, file_path)}`
				: template_name_in(root, file_path);
			add(file_path, name);
		}
	}

	for (const root of component_roots) {
		const files: string[] = [];
		scan_templates(root, files);
		for (const file_path of files) {
			const tag = strip_locale_variant(basename(file_path, TEMPLATE_EXT));
			// components/ wins outright over a same-named routes-tree file.
			index.set(tag, {
				kind: "template",
				file_path,
				template_name: `$components/${template_name_in(root, file_path)}`,
			});
		}
	}

	index_cache = { key: cache_key, index };
	return index;
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
