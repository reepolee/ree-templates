/**
 * Single source of truth for built-in template helper names.
 *
 * At runtime, tries to dynamically import the real helper_names module
 * from the detected project root. Falls back to a hardcoded copy that
 * mirrors `reepolee-dev/lib/template/helper_names.ts`.
 *
 * The source file is explicitly dependency-free (no $config/db import
 * chain), so it's safe to import() under Bun's native TS loader.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Fallback list - keep in sync with reepolee-dev/lib/template/helper_names.ts
// ---------------------------------------------------------------------------

export const DEFAULT_HELPER_NAMES: readonly string[] = [
	"url",
	"localized_path",
	"localized_path_for_locale",
	"format_bcp47",
	"format_og_locale",
	"locale_short_code",
	"nav_label",
	"is_current",
	"user_has_module",
	"is_checked",
	"js_date_to_locale_string",
	"js_time_to_locale_string",
	"js_datetime_to_locale_string",
	"js_timestamp_to_locale_string",
	"js_date_to_iso_string",
	"js_datetime_to_iso_string",
	"js_timestamp_to_iso_string",
	"now_today",
	"display_currency",
	"display_percent",
	"urlencode",
	"urldecode",
	"md",
	"pill",
	"tags",
	"yes_no",
	"human_bytes",
	"key_values",
	"image_thumbnail",
	"file_link",
	"file_icon_name",
];

// ---------------------------------------------------------------------------
// Runtime loader
// ---------------------------------------------------------------------------

/**
 * Try to load helper names from the project's actual helper_names.ts file.
 * Falls back to DEFAULT_HELPER_NAMES if the file can't be imported.
 */
export async function load_helper_names(project_root: string): Promise<readonly string[]> {
	// Reepolee-dev path
	const helper_path = join(project_root, "lib", "template", "helper_names.ts");
	if (existsSync(helper_path)) {
		try {
			// Bun supports importing .ts files directly at runtime
			const mod = await import(helper_path);
			if (Array.isArray(mod.DEFAULT_HELPER_NAMES)) {
				return mod.DEFAULT_HELPER_NAMES as readonly string[];
			}
		} catch {
			// Import failed - use fallback
		}
	}

	return DEFAULT_HELPER_NAMES;
}
