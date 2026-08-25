import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

// loader.ts has no `vscode` dependency, so bundle it with esbuild (the same
// trick the expand-ree-tag tests use) and exercise the real code.
async function load_bundled(entry_point) {
	const result = await esbuild.build({
		entryPoints: [entry_point],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		write: false,
	});
	const code = result.outputFiles[0].text;
	const module = { exports: {} };
	new Function('module', 'exports', 'require', code)(module, module.exports, require);
	return module.exports;
}

const { loadTranslations } = await load_bundled(
	new URL('../src/i18n/loader.ts', import.meta.url).pathname.replace(/^\/(\w):/, '$1:')
);

const temp_dirs = [];
after(() => {
	for (const dir of temp_dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function make_project() {
	const root = mkdtempSync(join(tmpdir(), 'ree-i18n-'));
	temp_dirs.push(root);
	// Project-root marker so the loader's ancestor walk stops at the root
	// instead of escaping into the surrounding filesystem.
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
	return root;
}

test('finds locale files in a locales/ subfolder of the template directory', () => {
	const root = make_project();
	mkdirSync(join(root, 'locales'), { recursive: true });
	writeFileSync(
		join(root, 'locales', 'en-us.json'),
		JSON.stringify({ outside_temperature: { label: 'Outside Temperature' } })
	);
	writeFileSync(
		join(root, 'locales', 'sl-si.json'),
		JSON.stringify({ outside_temperature: { label: 'Zunanja temperatura' } })
	);

	const data = loadTranslations(join(root, 'page.ree'));

	assert.ok(data);
	assert.equal(data['en-us']['outside_temperature.label'], 'Outside Temperature');
	assert.equal(data['sl-si']['outside_temperature.label'], 'Zunanja temperatura');
});

test('walks the ancestor chain so route-local locales/ overrides project root', () => {
	const root = make_project();
	mkdirSync(join(root, 'locales'), { recursive: true });
	mkdirSync(join(root, 'apps', 'main', 'home', 'locales'), { recursive: true });

	writeFileSync(
		join(root, 'locales', 'en-us.json'),
		JSON.stringify({
			outside_temperature: { label: 'Shared Temperature' },
			shared_only: { title: 'Shared' },
		})
	);
	writeFileSync(
		join(root, 'apps', 'main', 'home', 'locales', 'en-us.json'),
		JSON.stringify({ outside_temperature: { label: 'Outside Temperature' } })
	);

	const data = loadTranslations(join(root, 'apps', 'main', 'home', 'home.ree'));

	assert.ok(data);
	assert.equal(data['en-us']['outside_temperature.label'], 'Outside Temperature');
	assert.equal(data['en-us']['shared_only.title'], 'Shared');
});

test('returns null when no locale files exist anywhere in the chain', () => {
	const root = make_project();
	mkdirSync(join(root, 'apps', 'main', 'home'), { recursive: true });

	const data = loadTranslations(join(root, 'apps', 'main', 'home', 'home.ree'));

	assert.equal(data, null);
});

test('directories without locale files are skipped without dropping others', () => {
	const root = make_project();
	mkdirSync(join(root, 'apps', 'main', 'home', 'locales'), { recursive: true });
	// An ancestor directory with no locale files at all
	mkdirSync(join(root, 'apps', 'main', 'other'), { recursive: true });
	writeFileSync(
		join(root, 'apps', 'main', 'home', 'locales', 'en-us.json'),
		JSON.stringify({ ui: { title: 'Home' } })
	);

	const data = loadTranslations(join(root, 'apps', 'main', 'home', 'home.ree'));

	assert.ok(data);
	assert.equal(data['en-us']['ui.title'], 'Home');
});
