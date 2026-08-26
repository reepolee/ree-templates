/** Load helper names from the opened project's local declaration. */

import { existsSync } from "node:fs";
import { join } from "node:path";

const HELPER_NAME_PATHS = [
	["lib", "helper_names.ts"],
	["src", "lib", "helper_names.ts"],
] as const;

export async function load_helper_names(project_root: string): Promise<readonly string[]> {
	for (const path_segments of HELPER_NAME_PATHS) {
		const helper_path = join(project_root, ...path_segments);
		if (!existsSync(helper_path)) continue;

		try {
			const mod = await import(helper_path);
			if (Array.isArray(mod.DEFAULT_HELPER_NAMES)) {
				return mod.DEFAULT_HELPER_NAMES as readonly string[];
			}
		} catch {
			return [];
		}
	}

	return [];
}
