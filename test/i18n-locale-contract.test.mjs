import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const settings_source = await readFile(
	new URL('../src/i18n/settings.ts', import.meta.url),
	'utf8'
);
const locale_file_source = await readFile(
	new URL('../src/i18n/locale_file.ts', import.meta.url),
	'utf8'
);
const diagnostics_source = await readFile(
	new URL('../src/i18n/diagnostics.ts', import.meta.url),
	'utf8'
);

test('reads the supported_locales BCP 47 configuration contract', () => {
	assert.match(settings_source, /supported_locales\.ts/);
	assert.match(settings_source, /export\s+const\s+locales/);
	assert.match(settings_source, /export\s+const\s+locale_names/);
	assert.match(settings_source, /export\s+const\s+default_locale/);
	assert.match(settings_source, /"en-US"/);
	assert.doesNotMatch(settings_source, /supported_languages\.ts/);
});

test('recognizes BCP 47 locale JSON filenames', () => {
	assert.match(locale_file_source, /\^\[a-z\]\{2,3\}\(\?:-\[a-z0-9\]\{2,8\}\)\+\\\.json\$/);
	assert.match(locale_file_source, /en-US\.json/);
	assert.match(locale_file_source, /sl-SI\.json/);
});

test('creates configured locale files instead of language files', () => {
	assert.match(diagnostics_source, /get_supported_locales\(\)/);
	assert.match(diagnostics_source, /supported\.codes\.map\(locale_file_name\)/);
	assert.doesNotMatch(diagnostics_source, /'en\.json'/);
	assert.doesNotMatch(diagnostics_source, /'sl\.json'/);
});
