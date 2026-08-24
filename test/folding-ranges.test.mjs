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

test('keeps nested sibling and ancestor tags available for folding', () => {
	const source = [
		'<body>',
		'\t<aside>',
		'\t\t<nav-item>Navigation</nav-item>',
		'\t</aside>',
		'\t<main>',
		'\t\t<content-card>Content</content-card>',
		'\t</main>',
		'</body>',
	].join('\n');

	const ranges = compute_folding_ranges(source);
	assert.equal(ranges.length, 3);
	assert.ok(ranges.some(range => range.startLine === 0 && range.endLine === 7));
	assert.ok(ranges.some(range => range.startLine === 1 && range.endLine === 3));
	assert.ok(ranges.some(range => range.startLine === 4 && range.endLine === 6));
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

test('folds REE switch blocks and their case branches', () => {
	const source = [
		'{#switch props.status}',
		'\t{#case 10}',
		'\t\t<p>ten</p>',
		'\t\t<span>more</span>',
		'\t{#case 100}',
		'\t\t<p>hundred</p>',
		'\t\t<span>more</span>',
		'\t{:else}',
		'\t\t<p>other</p>',
		'\t\t<span>more</span>',
		'{/switch}',
	].join('\n');

	const ranges = compute_folding_ranges(source);
	// The switch block itself folds from line 0 to line 10.
	assert.ok(ranges.some(range => range.startLine === 0 && range.endLine === 10), 'switch block should fold');
	// Each case branch body folds from after its {#case} line to before the
	// next boundary, including leading/trailing whitespace text nodes.
	assert.ok(ranges.some(range => range.startLine === 1 && range.endLine === 4), 'first case body should fold');
	assert.ok(ranges.some(range => range.startLine === 4 && range.endLine === 7), 'second case body should fold');
	// The {:else} body folds from the else line to before {/switch}.
	assert.ok(ranges.some(range => range.startLine === 7 && range.endLine === 10), 'else body should fold');
});
