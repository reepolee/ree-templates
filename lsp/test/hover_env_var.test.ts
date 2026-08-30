import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compute_hover } from "../src/features/hover";
import { detect_profile } from "../src/profiles/index";

const temp_dirs: string[] = [];

afterEach(() => {
	for (const temp_dir of temp_dirs.splice(0)) {
		rmSync(temp_dir, { recursive: true, force: true });
	}
});

describe("Environment variable hover", () => {
	test("loads the active project's exact uppercase variable description", async () => {
		const project_root = create_project();
		const profile = await detect_profile(project_root);
		expect(profile).not.toBeNull();

		const source = "{= Bun.env.PORT }";
		const hover = compute_hover(source, { line: 0, character: source.indexOf("PORT") + 1 }, profile);
		const value = hover_value(hover);

		expect(value).toContain("**Environment variable** `PORT`");
		expect(value).toContain("Main app port from this project.");
	});

	test("uses the configured project-relative descriptions path", async () => {
		const descriptions_path = "settings/environment_docs.ts";
		const project_root = create_project(descriptions_path);
		const profile = await detect_profile(project_root, descriptions_path);
		const source = "{= process.env.PORT }";
		const hover = compute_hover(source, { line: 0, character: source.indexOf("PORT") + 1 }, profile);

		expect(hover_value(hover)).toContain("Main app port from this project.");
	});

	test("recognizes require_env string arguments", async () => {
		const project_root = create_project();
		const profile = await detect_profile(project_root);
		const source = 'const DEV_CONNECTION_STRING = require_env("DEV_CONNECTION_STRING");';
		const hover = compute_hover(source, { line: 0, character: source.indexOf("DEV_CONNECTION_STRING") + 1 }, profile);
		const quoted_hover = compute_hover(source, { line: 0, character: source.lastIndexOf("DEV_CONNECTION_STRING") + 1 }, profile);

		expect(hover_value(hover)).toContain("Development DB description from this project.");
		expect(hover_value(quoted_hover)).toContain("Development DB description from this project.");
	});

	test("does not match lowercase, unknown, or extended names", async () => {
		const project_root = create_project();
		const profile = await detect_profile(project_root);
		const sources = [
			["{= Bun.env.port }", "port"],
			["{= Bun.env.UNKNOWN }", "UNKNOWN"],
			["{= Bun.env.PORT_SUFFIX }", "PORT_SUFFIX"],
			["{= PORT }", "PORT"],
		];

		for (const source_entry of sources) {
			const source = source_entry[0]!;
			const variable = source_entry[1]!;
			const hover = compute_hover(source, { line: 0, character: source.indexOf(variable) + 1 }, profile);
			expect(hover_value(hover)).not.toContain("Main app port from this project.");
		}
	});
});

function create_project(descriptions_path = "config/env_var_descriptions.ts"): string {
	const project_root = mkdtempSync(join(tmpdir(), "ree-lsp-env-hover-"));
	temp_dirs.push(project_root);
	mkdirSync(join(project_root, dirname(descriptions_path)), { recursive: true });
	writeFileSync(join(project_root, "package.json"), JSON.stringify({
		ree: {
			project_family: "reepolee",
			template_roots: ["routes"],
			component_roots: ["components"],
			translation_provider: "route-json",
			translation_roots: ["routes"],
		},
	}), "utf-8");
	writeFileSync(
		join(project_root, descriptions_path),
		'export const ENV_VAR_DESCRIPTIONS: Record<string, string> = { PORT: "Main app port from this project.", DEV_CONNECTION_STRING: "Development DB description from this project." };\n',
		"utf-8",
	);
	return project_root;
}

function hover_value(hover: ReturnType<typeof compute_hover>): string {
	if (!hover || typeof hover.contents === "string" || Array.isArray(hover.contents)) return "";
	return hover.contents.value;
}
