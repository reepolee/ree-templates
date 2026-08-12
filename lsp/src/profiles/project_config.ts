/**
 * Project metadata for the bundled Ree project adapters.
 *
 * Metadata is read from package.json only. The language server never executes
 * workspace code to discover a project's template conventions.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export type ProjectFamily = "reepolee" | "reeweb";
export type TranslationProviderName = "route-json";

export interface ReeProjectConfig {
	project_family: ProjectFamily;
	template_roots: string[];
	component_roots: string[];
	translation_provider: TranslationProviderName;
	translation_roots: string[];
}

interface PackageReeConfig {
	project_family?: unknown;
	template_roots?: unknown;
	component_roots?: unknown;
	translation_provider?: unknown;
	translation_roots?: unknown;
}

export function read_project_config(project_root: string): ReeProjectConfig | null {
	const package_file = join(project_root, "package.json");
	if (!existsSync(package_file)) return null;

	try {
		const package_content = readFileSync(package_file, "utf-8");
		const package_data = JSON.parse(package_content) as { ree?: PackageReeConfig };
		if (!package_data.ree) return null;
		return validate_project_config(package_data.ree, project_root);
	} catch {
		return null;
	}
}

function validate_project_config(config: PackageReeConfig, project_root: string): ReeProjectConfig | null {
	if (config.project_family !== "reepolee" && config.project_family !== "reeweb") return null;
	if (config.translation_provider !== "route-json") return null;

	const template_roots = validate_relative_paths(config.template_roots, project_root);
	const component_roots = validate_relative_paths(config.component_roots, project_root);
	const translation_roots = validate_relative_paths(config.translation_roots, project_root);
	if (!template_roots || !component_roots || !translation_roots) return null;

	return {
		project_family: config.project_family,
		template_roots,
		component_roots,
		translation_provider: config.translation_provider,
		translation_roots,
	};
}

function validate_relative_paths(value: unknown, project_root: string): string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;

	const paths: string[] = [];
	for (const entry of value) {
		const path_value = validate_relative_path(entry, project_root);
		if (!path_value) return null;
		paths.push(path_value);
	}

	return paths;
}

function validate_relative_path(value: unknown, project_root: string): string | null {
	if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return null;

	const normalized = normalize(value);
	const resolved = join(project_root, normalized);
	const project_relative = relative(project_root, resolved);
	if (project_relative === ".." || project_relative.startsWith(`..${sep}`)) return null;

	return normalized;
}
