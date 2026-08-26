import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detect_profile } from "../src/profiles/index";

const temp_dirs: string[] = [];

afterEach(() => {
	for (const temp_dir of temp_dirs.splice(0)) {
		rmSync(temp_dir, { recursive: true, force: true });
	}
});

describe("package.json Ree project metadata", () => {
	test("selects the Reeweb adapter for a renamed clone", async () => {
		const project_root = create_project("reeweb");
		const profile = await detect_profile(project_root);

		expect(profile?.name).toBe("reeweb");
		expect(profile?.route_roots).toEqual([join(project_root, "src", "public")]);
	});

	test("selects the Reepolee adapter for a renamed clone", async () => {
		const project_root = create_project("reepolee");
		const profile = await detect_profile(project_root);

		expect(profile?.name).toBe("reepolee");
		expect(profile?.translation_roots).toEqual([join(project_root, "routes"), join(project_root, "routes_reeman")]);
	});

	test("loads helper names from the detected project", async () => {
		const project_root = create_project("reepolee");
		const helper_dir = join(project_root, "lib", "template");
		mkdirSync(helper_dir, { recursive: true });
		writeFileSync(
			join(helper_dir, "helper_names.ts"),
			'export const DEFAULT_HELPER_NAMES = ["custom_timestamp_helper"] as const;\n',
			"utf-8",
		);

		const profile = await detect_profile(project_root);

		expect(profile?.helper_names).toEqual(["custom_timestamp_helper"]);
	});
});

function create_project(project_family: "reepolee" | "reeweb"): string {
	const project_root = mkdtempSync(join(tmpdir(), "renamed-ree-project-"));
	temp_dirs.push(project_root);

	const config = project_family === "reepolee"
		? {
			project_family,
			template_roots: ["routes"],
			component_roots: ["components"],
			translation_provider: "route-json",
			translation_roots: ["routes", "routes_reeman"],
		}
		: {
			project_family,
			template_roots: ["src/public"],
			component_roots: ["src/components"],
			translation_provider: "route-json",
			translation_roots: ["src/public"],
		};

	const package_data = { name: "customer-site", ree: config };
	const package_content = JSON.stringify(package_data, null, "\t");
	const package_file = join(project_root, "package.json");
	writeFileSync(package_file, package_content, "utf-8");
	return project_root;
}
