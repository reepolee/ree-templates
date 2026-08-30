/**
 * reeweb SSG project profile.
 *
 * Conventions:
 * - Page templates live in `src/public/` (file-based SSG routing)
 * - Components live in `components/` or `src/components/`
 * - Layouts in `src/layouts/`
 * - Translations are locale JSON files under `src/public/`
 * - Root locale files provide global strings and route-local files override them
 * - Helper names & include resolver imported at runtime from the project
 *
 * Note: `$routes/` in reeweb maps to `src/public/`, not `routes/`.
 * The real resolver doesn't handle this difference, so we pre-process
 * the path value before delegating.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ReeProjectProfile, ResolvedTarget } from "./index";
import { is_locale_file, resolve_template_file, within_base, flatten_json } from "./index";
import { load_helper_names } from "./helper_loader";
import { load_env_var_descriptions } from "./env_var_descriptions";
import { local_resolve } from "./include_loader";
import type { ReeProjectConfig } from "./project_config";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function create_reeweb_profile(project_root: string, config: ReeProjectConfig, env_var_descriptions_path = "config/env_var_descriptions.ts"): Promise<ReeProjectProfile> {
	const route_roots = config.template_roots.map((template_root) => join(project_root, template_root));
	const component_roots = config.component_roots.map((component_root) => join(project_root, component_root));
	const views_dir = route_roots[0]!;
	const component_root = component_roots[0]!;
	const translation_root = join(project_root, config.translation_roots[0]!);
	const helper_names = await load_helper_names(project_root);
	const env_var_descriptions = await load_env_var_descriptions(project_root, env_var_descriptions_path);

	return {
		project_root,
		name: "reeweb",
		label: "reeweb (SSG)",
		route_roots,
		component_roots,
		translation_roots: [translation_root],
		helper_names,
		env_var_descriptions,

		resolve_include(path_value: string, from_file: string): ResolvedTarget | undefined {
			// Pre-process: $routes/ → non-alias path (views-relative page)
			// The real resolver maps $routes/x → routes/x, but reeweb pages
			// are in src/public/. We strip the alias prefix so it resolves
			// relative to views_dir (src/public/).
			let fixed = path_value;
			if (fixed.startsWith("$routes/")) {
				fixed = fixed.slice("$routes/".length);
			}

			return local_resolve(fixed, from_file, views_dir);
		},

		resolve_component(tag_name: string): ResolvedTarget | undefined {
			const file_path = resolve_template_file(join(component_root, tag_name));
			if (!file_path) return undefined;
			const safe = within_base(file_path, component_root);
			if (!safe) return undefined;
			return { kind: "template", file_path: safe, template_name: `components/${tag_name}` };
		},

		load_translation_index(locale_file: string, from_ree_file?: string): Map<string, string> | null {
			return load_json_translations(locale_file, translation_root, from_ree_file);
		},

		translation_definition_files(from_ree_file: string): string[] {
			return definition_files(translation_root, from_ree_file);
		},
	};
}

function definition_files(translation_root: string, from_ree_file: string): string[] {
	const root_files = locale_files_in(translation_root);
	const route_dir = dirname(from_ree_file);
	const safe_route_dir = within_base(route_dir, translation_root);
	if (!safe_route_dir || safe_route_dir === translation_root) return root_files;

	const route_files = locale_files_in(safe_route_dir);
	return [...route_files, ...root_files];
}

function locale_files_in(root: string): string[] {
	try {
		const files = readdirSync(root).filter(is_locale_file);
		files.sort();
		return files.map((file_name) => join(root, file_name));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Translation index loading (local JSON files)
// ---------------------------------------------------------------------------

function load_json_translations(locale_file: string, views_dir: string, from_ree_file?: string): Map<string, string> | null {
	try {
		if (!existsSync(locale_file)) return null;
		const root_data = read_json_object(locale_file);
		let merged = root_data;

		if (from_ree_file) {
			const route_dir = dirname(from_ree_file);
			const safe_route_dir = within_base(route_dir, views_dir);
			if (safe_route_dir && safe_route_dir !== views_dir) {
				const locale_name = basename(locale_file);
				const route_locale_file = join(safe_route_dir, locale_name);
				if (existsSync(route_locale_file)) {
					const route_data = read_json_object(route_locale_file);
					merged = deep_merge(root_data, route_data);
				}
			}
		}

		const map = new Map<string, string>();
		flatten_json(merged, "", map);
		return map;
	} catch {
		return null;
	}
}

function read_json_object(file_path: string): Record<string, unknown> {
	const content = readFileSync(file_path, "utf-8");
	return JSON.parse(content) as Record<string, unknown>;
}

function is_object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deep_merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...target };

	for (const key of Object.keys(source)) {
		const target_value = merged[key];
		const source_value = source[key];
		if (is_object(target_value) && is_object(source_value)) {
			merged[key] = deep_merge(target_value, source_value);
		} else {
			merged[key] = source_value;
		}
	}

	return merged;
}
