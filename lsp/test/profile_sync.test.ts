/**
 * Sync tests - verify that the LSP's fallback constants match the
 * actual project source files they mirror.
 *
 * These tests import the real files under Bun's native TS loader.
 * They fail when the source of truth changes but our copy wasn't updated,
 * preventing silent drift.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Our fallback
import { DEFAULT_HELPER_NAMES } from "../src/profiles/helper_loader";

// ---------------------------------------------------------------------------
// Resolve path to the real helper_names file
// ---------------------------------------------------------------------------

const REEPOLEE_DEV_HELPER_FILE = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"reepolee-dev",
	"lib",
	"template",
	"helper_names.ts",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fallback constants stay in sync with source files", () => {

	test("DEFAULT_HELPER_NAMES matches real helper_names.ts", async () => {
		if (!existsSync(REEPOLEE_DEV_HELPER_FILE)) {
			console.warn(`  ⚠ Skipping: source file not found at ${REEPOLEE_DEV_HELPER_FILE}`);
			return;
		}

		const real = await import(REEPOLEE_DEV_HELPER_FILE);

		expect(Array.isArray(real.DEFAULT_HELPER_NAMES)).toBe(true);

		const real_names = real.DEFAULT_HELPER_NAMES as readonly string[];

		// Same length
		expect(DEFAULT_HELPER_NAMES.length).toBe(real_names.length);

		// Same content, same order
		for (let i = 0; i < real_names.length; i++) {
			const expected = real_names[i];
			const actual = DEFAULT_HELPER_NAMES[i];
			if (expected !== actual) {
				// Give a helpful diff message
				const msg = [
					`DEFAULT_HELPER_NAMES mismatch at index ${i}`,
					`  expected: "${expected}"`,
					`  actual:   "${actual ?? "(missing)"}"`,
					``,
					`Run: diff <(echo "${real_names.join("\\n")}") <(echo "${DEFAULT_HELPER_NAMES.join("\\n")}")`,
				].join("\n");
				expect(actual).toBe(expected); // will fail with helpful diff
			}
		}

		console.log(`  ✅ ${real_names.length} helper names match the real source`);
	});

	test("load_helper_names() returns real names when project exists", async () => {
		const project_root = join(import.meta.dir, "..", "..", "..", "reepolee-dev");

		if (!existsSync(join(project_root, "lib", "template", "helper_names.ts"))) {
			console.warn(`  ⚠ Skipping: project not found at ${project_root}`);
			return;
		}

		const { load_helper_names } = await import("../src/profiles/helper_loader");
		const names = await load_helper_names(project_root);

		expect(names.length).toBe(DEFAULT_HELPER_NAMES.length);

		// The imported names should equal our fallback (since both match reality)
		expect([...names]).toEqual([...DEFAULT_HELPER_NAMES]);

		console.log(`  ✅ load_helper_names() returned ${names.length} names from real project`);
	});
});
