import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

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

const symbols_url = new URL('../lsp/src/features/symbols.ts', import.meta.url);
const { compute_folding_ranges } = await load_bundled(
	symbols_url.pathname.replace(/^\/(\w):/, '$1:')
);

test('folds multiline native HTML and REE component elements through their closing tags', () => {
	const source = [
		'<main>',
		'\t<section>',
		'\t\t<user-card>',
		'\t\t\t<span>Hi</span>',
		'\t\t</user-card>',
		'\t</section>',
		'</main>',
	].join('\n');

	assert.deepEqual(compute_folding_ranges(source), [
		{ startLine: 0, startCharacter: 0, endLine: 6, endCharacter: 7 },
		{ startLine: 1, startCharacter: 1, endLine: 5, endCharacter: 11 },
		{ startLine: 2, startCharacter: 2, endLine: 4, endCharacter: 14 },
	]);
});

test('folds REE blocks alongside their HTML children', () => {
	const source = [
		'{#if props.show}',
		'\t<div>',
		'\t\t<p>Content</p>',
		'\t</div>',
		'{/if}',
	].join('\n');

	const ranges = compute_folding_ranges(source);
	assert.ok(ranges.some(range => range.startLine === 0 && range.endLine === 4));
	assert.ok(ranges.some(range => range.startLine === 1 && range.endLine === 3));
});
