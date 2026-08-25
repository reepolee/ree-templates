import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compute_hover, invalidate_translation_cache } from "../src/features/hover";
import { detect_profile, type ReeProjectProfile } from "../src/profiles/index";

const temp_dirs: string[] = [];

afterEach(() => {
	invalidate_translation_cache();
	for (const temp_dir of temp_dirs.splice(0)) {
		rmSync(temp_dir, { recursive: true, force: true });
	}
});

describe("Translation hover", () => {
	test("keeps route namespaces isolated in the cache", async () => {
		const project_root = join(import.meta.dir, "..", "..", "..", "reepolee-dev");
		const profile = await detect_profile(project_root);
		expect(profile?.name).toBe("reepolee");

		const source = "{_ ui.title }";
		const position = { line: 0, character: 5 };
		const home_file = join(project_root, "apps", "main", "home", "home.ree");
		const kitchen_file = join(project_root, "apps", "main", "examples", "kitchen_sink", "kitchen_sink.ree");
		const home_uri = pathToFileURL(home_file).href;
		const kitchen_uri = pathToFileURL(kitchen_file).href;

		const home_hover = compute_hover(source, position, profile, home_uri);
		const kitchen_hover = compute_hover(source, position, profile, kitchen_uri);
		const home_value = hover_value(home_hover);
		const kitchen_value = hover_value(kitchen_hover);

		expect(home_value).toContain("Home Page");
		expect(kitchen_value).toContain("Kitchen Sink");
		expect(kitchen_value).not.toContain("Home Page");

		// Shadow overrides must not duplicate rows: each locale appears once.
		expect(home_value.match(/\| EN-US \|/g)?.length).toBe(1);
		expect(home_value.match(/\| SL-SI \|/g)?.length).toBe(1);
	});

	test("merges Reeweb root and route-local translations", async () => {
		const project_root = join(import.meta.dir, "..", "..", "..", "reeweb");
		const profile = await detect_profile(project_root);
		expect(profile?.name).toBe("reeweb");

		const source = "{_ ui.title }";
		const position = { line: 0, character: 5 };
		const contact_file = join(project_root, "src", "public", "contact", "index.ree");
		const contact_uri = pathToFileURL(contact_file).href;
		const contact_hover = compute_hover(source, position, profile, contact_uri);
		const contact_value = hover_value(contact_hover);

		expect(contact_value).toContain("Contact Us");
		expect(contact_value).toContain("Kontakt");
	});

	test("shows values from every locale", () => {
		const translation_root = mkdtempSync(join(tmpdir(), "ree-lsp-hover-"));
		temp_dirs.push(translation_root);

		for (let index = 0; index < 12; index++) {
			const locale_code = String(index).padStart(2, "0");
			const locale_file = join(translation_root, `aa-${locale_code}.json`);
			writeFileSync(locale_file, "{}", "utf-8");
		}

		const profile = fake_profile(translation_root);
		const hover = compute_hover("{_ ui.title }", { line: 0, character: 5 }, profile, "file:///project/routes/home.ree");
		const value = hover_value(hover);
		// Values render bold inside the locale table.
		const locale_values = value.match(/\*\*value-\d+\*\*/g);

		expect(locale_values?.length).toBe(12);
	});
});

function hover_value(hover: ReturnType<typeof compute_hover>): string {
	if (!hover || typeof hover.contents === "string" || Array.isArray(hover.contents)) return "";
	return hover.contents.value;
}

function fake_profile(translation_root: string): ReeProjectProfile {
	return {
		project_root: "/project",
		name: "reepolee",
		label: "test",
		route_roots: [],
		component_roots: [],
		translation_roots: [translation_root],
		helper_names: [],
		resolve_include() {
			return undefined;
		},
		resolve_component() {
			return undefined;
		},
		load_translation_index(locale_file: string) {
			const locale_name = locale_file.slice(locale_file.lastIndexOf("-") + 1, locale_file.lastIndexOf("."));
			return new Map([["ui.title", `value-${locale_name}`]]);
		},
	};
}
