import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	test("selects the Ree Web adapter for a renamed clone", async () => {
		const project_root = create_project("ree-web");
		const profile = await detect_profile(project_root);

		expect(profile?.name).toBe("ree-web");
		expect(profile?.route_roots).toEqual([join(project_root, "src", "public")]);
	});

	test("selects the Reepolee adapter for a renamed clone", async () => {
		const project_root = create_project("reepolee");
		const profile = await detect_profile(project_root);

		expect(profile?.name).toBe("reepolee");
		expect(profile?.translation_roots).toEqual([join(project_root, ".reepolee", "i18n")]);
	});
});

function create_project(project_family: "reepolee" | "ree-web"): string {
	const project_root = mkdtempSync(join(tmpdir(), "renamed-ree-project-"));
	temp_dirs.push(project_root);

	const config = project_family === "reepolee"
		? {
			project_family,
			template_roots: ["routes"],
			component_roots: ["components"],
			translation_provider: "db-export",
			translation_root: ".reepolee/i18n",
		}
		: {
			project_family,
			template_roots: ["src/public"],
			component_roots: ["src/components"],
			translation_provider: "route-json",
			translation_root: "src/public",
		};

	const package_data = { name: "customer-site", ree: config };
	const package_content = JSON.stringify(package_data, null, "\t");
	const package_file = join(project_root, "package.json");
	writeFileSync(package_file, package_content, "utf-8");
	return project_root;
}
