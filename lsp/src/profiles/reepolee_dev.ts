/**
 * reepolee-dev project profile.
 *
 * Conventions:
 * - Routes live in `routes/` (standard module-based routing)
 * - Components live in `components/` (hyphenated .ree files)
 * - Translations are DB-first; `.reepolee/i18n/` is a read-only editor export
 * - Helper names & include resolver imported at runtime from the project
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ReeProjectProfile, ResolvedTarget } from "./index";
import { resolve_template_file, within_base, flatten_json } from "./index";
import { DEFAULT_HELPER_NAMES } from "./helper_loader";
import { local_resolve } from "./include_loader";
import type { ReeProjectConfig } from "./project_config";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function create_reepolee_profile(project_root: string, config: ReeProjectConfig): Promise<ReeProjectProfile> {
	const route_roots = config.template_roots.map((template_root) => join(project_root, template_root));
	const component_roots = config.component_roots.map((component_root) => join(project_root, component_root));
	const translation_root = join(project_root, config.translation_root);
	const views_dir = route_roots[0]!;
	const components_dir = component_roots[0]!;

	return {
		project_root,
		name: "reepolee",
		label: "Reepolee",
		route_roots,
		component_roots,
		translation_roots: [translation_root],
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
			return load_ree_i18n_export(locale_file, from_ree_file);
		},
	};
}

// ---------------------------------------------------------------------------
// Translation index loading (read-only DB export)
// ---------------------------------------------------------------------------

/**
 * Load a DB-exported locale JSON file and flatten it into a key→value map.
 *
 * When `from_ree_file` is provided, resolves keys against the template's
 * route namespace - merging `routes.*` (root) with the subtree at
 * `routes.<namespace>.*`, matching the server's `resolve_translations`.
 * This means `{_ labels.row_count }` in a template under `routes_reeman/db_tables/`
 * resolves to `routes.routes_reeman.db_tables.labels.row_count` in the export.
 */
function load_ree_i18n_export(locale_file: string, from_ree_file?: string): Map<string, string> | null {
	try {
		if (!existsSync(locale_file)) return null;
		const content = readFileSync(locale_file, "utf-8");
		const data = JSON.parse(content) as Record<string, unknown>;

		if (from_ree_file) {
			return load_namespaced(data, from_ree_file);
		}

		// No file context - flatten entire export
		const map = new Map<string, string>();
		flatten_json(data, "", map);
		return map;
	} catch {
		return null;
	}
}

/**
 * Merge `routes.*` root keys with the subtree at the template's route
 * namespace, then flatten. Mirrors `resolve_translations` in
 * reepolee-dev/lib/request_context.ts.
 */
function load_namespaced(tree: Record<string, unknown>, ree_file_path: string): Map<string, string> {
	const ns = route_namespace(ree_file_path);

	// Root keys: everything under `routes` in the export (nav, labels, actions, etc.)
	const root_routes = is_obj(tree.routes) ? tree.routes : {};

	// Subtree at the file's route namespace: top-level key in the export
	// (e.g. `db_tables` for routes_reeman/db_tables/detail.ree)
	// Use the full tree, not just tree.routes
	const subtree = get_nested(tree, ns.replace(/\//g, "."));

	// Merge: root provides shared keys, subtree overrides with route-specific ones
	const merged = deep_merge(root_routes as Record<string, unknown>, subtree);

	const map = new Map<string, string>();
	flatten_json(merged, "", map);
	return map;
}

/** Extract the route namespace from a .ree file path. */
function route_namespace(ree_file_path: string): string {
	const dir = dirname(ree_file_path).replace(/\\/g, "/");
	const segs = dir.split("/");
	const idx = segs.findIndex(s => /^routes[^/]*$/.test(s));
	if (idx === -1) return "";
	return segs.slice(idx + 1).join("/");
}

function is_obj(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function get_nested(obj: Record<string, unknown>, path: string): Record<string, unknown> {
	if (!path) return obj as Record<string, unknown>;
	const parts = path.split(".").filter(Boolean);
	let cur: unknown = obj;
	for (const p of parts) {
		if (!is_obj(cur)) return {};
		cur = cur[p];
	}
	return is_obj(cur) ? cur : {};
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
