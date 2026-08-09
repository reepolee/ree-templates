/**
 * Project profile interface and discovery.
 *
 * Each profile encapsulates project-specific conventions:
 * - directory layout (routes, components, translations)
 * - path resolution (includes, layouts, components)
 * - translation indexing (DB export vs local JSON)
 *
 * Detection walks upward from the document directory looking for
 * unambiguous project markers.
 */

import { existsSync } from "node:fs";
import { join, resolve as path_resolve, relative, sep } from "node:path";
import { read_project_config, type ReeProjectConfig } from "./project_config";

// ---------------------------------------------------------------------------
// Profile type
// ---------------------------------------------------------------------------

export type ProfileName = "reepolee" | "reeweb" | "unknown";

export interface ResolvedTarget {
	/** Absolute filesystem path */
	file_path: string;
	/** Whether this is a template (.ree) or raw file */
	kind: "template" | "raw";
	/** Template name (views-root relative, no extension) when kind is template */
	template_name?: string;
}

export interface ReeProjectProfile {
	/** Absolute project root. */
	project_root: string;
	/** Unique profile identifier */
	name: ProfileName;
	/** Display label for diagnostics/logging */
	label: string;
	/** Root directories where routes/templates live */
	route_roots: string[];
	/** Root directories where components live */
	component_roots: string[];
	/** Root directories where translations are exported */
	translation_roots: string[];
	/** Built-in helper function names available in templates */
	helper_names: readonly string[];
	/**
	 * Resolve an include/layout path literal to a filesystem target.
	 * Returns undefined when the target cannot be found or the path
	 * is dynamic/non-literal.
	 */
	resolve_include(path_value: string, from_file: string): ResolvedTarget | undefined;
	/**
	 * Resolve a component tag name to a filesystem target.
	 */
	resolve_component(tag_name: string): ResolvedTarget | undefined;
	/**
	 * Load the translation index for a given locale export.
	 * When `from_ree_file` is provided, resolves keys against the template's
	 * route namespace so that `{_ labels.row_count }` matches
	 * `routes.routes_reeman.db_tables.labels.row_count` in the export.
	 * Returns a map of key → value, or null when no export is available.
	 */
	load_translation_index?(locale_file: string, from_ree_file?: string): Map<string, string> | null;
	/**
	 * Locale files to search for a translation definition. Route-local sources
	 * precede shared sources when a provider layers translations by route.
	 */
	translation_definition_files?(from_ree_file: string): string[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Try to detect a project profile from a filesystem path.
 * Walks upward from `start_dir` looking for project markers.
 *
 * Returns a profile or `null` when no recognized project is found
 * (structural features still work without a profile).
 */
export async function detect_profile(start_dir: string): Promise<ReeProjectProfile | null> {
	let dir = start_dir;

	while (true) {
		const project_config = read_project_config(dir);
		if (project_config) {
			const profile = await create_profile_from_config(dir, project_config);
			if (profile) return profile;
		}

		// Legacy project markers preserve editor support for projects created
		// before the package.json Ree metadata was introduced.
		if (existsSync(join(dir, "routes")) && existsSync(join(dir, "lib", "template", "compiler.ts"))) {
			const { create_reepolee_profile } = await import("./reepolee_dev");
			return create_reepolee_profile(dir, legacy_reepolee_config());
		}

		if (
			existsSync(join(dir, "src", "public"))
			&& existsSync(join(dir, "lib", "template_engine.ts"))
			&& existsSync(join(dir, "lib", "i18n.ts"))
		) {
			const { create_reeweb_profile } = await import("./reeweb");
			return create_reeweb_profile(dir, legacy_reeweb_config());
		}

		// Walk up
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}

async function create_profile_from_config(project_root: string, config: ReeProjectConfig): Promise<ReeProjectProfile | null> {
	if (config.project_family === "reepolee") {
		const { create_reepolee_profile } = await import("./reepolee_dev");
		return create_reepolee_profile(project_root, config);
	}

	if (config.project_family === "reeweb") {
		const { create_reeweb_profile } = await import("./reeweb");
		return create_reeweb_profile(project_root, config);
	}

	return null;
}

function legacy_reepolee_config(): ReeProjectConfig {
	return {
		project_family: "reepolee",
		template_roots: ["routes"],
		component_roots: ["components"],
		translation_provider: "db-export",
		translation_root: ".reepolee/i18n",
	};
}

function legacy_reeweb_config(): ReeProjectConfig {
	return {
		project_family: "reeweb",
		template_roots: ["src/public"],
		component_roots: ["src/components"],
		translation_provider: "route-json",
		translation_root: "src/public",
	};
}

// ---------------------------------------------------------------------------
// Path helpers (shared across profiles)
// ---------------------------------------------------------------------------

/** Template file extension */
export const TEMPLATE_EXT = ".ree";

/** BCP 47 locale JSON filename used by both supported project families. */
export const LOCALE_FILE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})+\.json$/i;

export function is_locale_file(file_name: string): boolean {
	return LOCALE_FILE_RE.test(file_name);
}

/**
 * Resolve a path with optional .ree extension appending.
 * Returns the resolved path or undefined if not found.
 */
export function resolve_template_file(base_path: string): string | undefined {
	if (existsSync(base_path + TEMPLATE_EXT)) return base_path + TEMPLATE_EXT;
	if (existsSync(base_path)) return base_path;
	return undefined;
}

/**
 * Check that a resolved path does not escape its base directory.
 * Returns the resolved path or undefined if it would escape.
 */
export function within_base(file_path: string, base_path: string): string | undefined {
	const resolved = path_resolve(file_path);
	const resolved_base = path_resolve(base_path);
	const rel = relative(resolved_base, resolved);

	// A path is safe when it doesn't escape via ".." traversal
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
		return resolved;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Flatten a nested JSON object into a flat Map with dotted keys.
 * E.g. { "ui": { "title": "Hello" } } → Map { "ui.title" → "Hello" }
 */
export function flatten_json(obj: unknown, prefix: string, out: Map<string, string>): void {
	if (typeof obj !== "object" || obj === null) {
		if (prefix) out.set(prefix, String(obj));
		return;
	}

	if (Array.isArray(obj)) return;

	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const full_key = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			flatten_json(value, full_key, out);
		} else if (typeof value === "string") {
			out.set(full_key, value);
		}
	}
}
