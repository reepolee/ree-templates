import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

// The extension's source uses extensionless relative imports (bundled by
// esbuild at package time), which Node's native TS loader can't resolve
// directly. Bundle the two pure-logic modules (no `vscode` dependency) with
// esbuild so tests exercise real behavior instead of just pattern-matching
// source text.
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

const tag_parser_url = new URL('../src/expand/tag_parser.ts', import.meta.url);
const inline_component_url = new URL('../src/expand/inline_component.ts', import.meta.url);

const { find_ree_tag_at } = await load_bundled(tag_parser_url.pathname.replace(/^\/(\w):/, '$1:'));
const { inline_component } = await load_bundled(
	inline_component_url.pathname.replace(/^\/(\w):/, '$1:')
);

test('finds a self-closing ReeTag under the cursor and parses its attributes', () => {
	const source = `<auto-complete field-name="company_id" fk-table="companies"></auto-complete>`;
	const tag = find_ree_tag_at(source, 5);

	assert.ok(tag);
	assert.equal(tag.tag_name, 'auto-complete');
	assert.deepEqual(tag.attributes, [
		{ name: 'field-name', raw_value: 'company_id' },
		{ name: 'fk-table', raw_value: 'companies' },
	]);
	assert.equal(tag.slot_content, '');
	assert.equal(source.slice(tag.start, tag.end), source);
});

test('parses slot content between open and close tags', () => {
	const source = `<product-card product={= product } badge={= is_new ? 'NEW' : '' }>\n\t{= product.name }\n</product-card>`;
	const tag = find_ree_tag_at(source, 0);

	assert.ok(tag);
	assert.equal(tag.tag_name, 'product-card');
	assert.equal(tag.attributes.length, 2);
	assert.equal(tag.attributes[0].raw_value, '{= product }');
	assert.equal(tag.attributes[1].raw_value, "{= is_new ? 'NEW' : '' }");
	assert.match(tag.slot_content, /product\.name/);
});

test('ignores tags without a hyphen (plain HTML passthrough)', () => {
	const source = `<banner type="red">hi</banner>`;
	const tag = find_ree_tag_at(source, 5);
	assert.equal(tag, undefined);
});

test('inlines a plain string attribute as a literal and children as slot content', () => {
	const component_source = `<div class={= props.attributes.type }>{= props.children }</div>`;
	const tag = find_ree_tag_at(`<app-banner type="red">{= props.form_errors }</app-banner>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<div class='red'>{= props.form_errors }</div>`);
});

test('inlines a template-expression attribute by splicing the raw expression', () => {
	const component_source = `<span class={= props.attributes.badge ? 'pill' : '' }></span>`;
	const tag = find_ree_tag_at(`<product-card badge={= is_new ? 'NEW' : '' }></product-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<span class={= is_new ? 'NEW' : '' ? 'pill' : '' }></span>`);
});
