/** Load environment-variable descriptions from the active project. */

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const DEFAULT_ENV_VAR_DESCRIPTIONS_PATH = "config/env_var_descriptions.ts";

export async function load_env_var_descriptions(project_root: string, descriptions_file: string): Promise<ReadonlyMap<string, string>> {
	const descriptions_path = resolve_descriptions_path(project_root, descriptions_file);
	if (!descriptions_path) return new Map();
	if (!existsSync(descriptions_path)) return new Map();

	try {
		const descriptions_module = await import(descriptions_path);
		const raw_descriptions = descriptions_module.ENV_VAR_DESCRIPTIONS;
		if (!raw_descriptions || typeof raw_descriptions !== "object") return new Map();

		const descriptions = new Map<string, string>();
		for (const [name, description] of Object.entries(raw_descriptions as Record<string, unknown>)) {
			if (ENV_VAR_NAME_RE.test(name) && typeof description === "string" && description.length > 0) {
				descriptions.set(name, description);
			}
		}

		return descriptions;
	} catch {
		return new Map();
	}
}

function resolve_descriptions_path(project_root: string, descriptions_file: string): string | undefined {
	if (!descriptions_file || isAbsolute(descriptions_file)) return undefined;

	const normalized = normalize(descriptions_file);
	const resolved = join(project_root, normalized);
	const project_relative = relative(project_root, resolved);
	if (project_relative === ".." || project_relative.startsWith(`..${sep}`)) return undefined;
	return resolved;
}
