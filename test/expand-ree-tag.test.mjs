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

test('inlines a plain string attribute into a quoted HTML attribute value without extra quotes', () => {
	const component_source = `<input value="{~ props.attributes.foo }">`;
	const tag = find_ree_tag_at(`<date-field foo="2024-01-01"></date-field>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<input value="2024-01-01">`);
});

test('inlines a template-expression attribute into a quoted HTML attribute value as a tag', () => {
	const component_source = `<input value="{~ props.attributes.foo }">`;
	const tag = find_ree_tag_at(`<date-field foo={~ record.iso_date }></date-field>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<input value="{~ record.iso_date }">`);
});

test('inlines text content attributes without wrapping in quotes', () => {
	const component_source = `<label>{= props.attributes.label }</label>`;
	const tag = find_ree_tag_at(`<field-label label="Primary color"></field-label>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<label>Primary color</label>`);
});

test('inlines string interpolation in attributes without double-quoting', () => {
	const component_source = `<validation-error id="error-{= props.attributes.name }"></validation-error>`;
	const tag = find_ree_tag_at(`<form-field name="primary_color"></form-field>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<validation-error id="error-primary_color"></validation-error>`);
});

// A reference that is only part of a larger expression cannot collapse its
// tag, so the value is spliced in place. Inside a tag body that is a JS
// expression position: a plain string has to become a string literal to stay
// valid, and the surviving `|| fallback` is then dead code only the developer
// can resolve - hence the marker.

test('splices a string value as a literal inside a fallback expression and flags it', () => {
	const component_source = `<input value="{~ props.attributes.value || '#000000' }">`;
	const tag = find_ree_tag_at(`<input-color value="#ff0000"></input-color>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /value="\{~ '#ff0000' \|\| '#000000' \}"/);
	assert.match(inlined, /<!-- TODO: expression needs manual review/);
});

test('splices an expression value into a fallback expression without flagging it', () => {
	const component_source = `<input value="{~ props.attributes.value || '#000000' }">`;
	const tag = find_ree_tag_at(`<input-color value={= record.color }></input-color>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<input value="{~ record.color || '#000000' }">`);
});

test('does not flag a reference that is the whole tag body', () => {
	const component_source = `<input value="{~ props.attributes.value }">`;
	const tag = find_ree_tag_at(`<input-color value="#ff0000"></input-color>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<input value="#ff0000">`);
});

// `{#with props.attributes}` compiles to a native JS `with` statement, so a
// bare `label` and an explicit `props.attributes.label` are the same reference
// inside the block. Expansion supports both and must agree on the result.

test('expands bare references inside a {#with props.attributes} block', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<label for="{= name }">{= label }</label>',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<x-field name="primary_color" label="Primary color"></x-field>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<label for="primary_color">Primary color</label>`);
});

test('expands both component styles to identical output', () => {
	const with_style = [
		'{#with props.attributes}',
		'\t<label for="{= name }">{= label }</label>',
		"\t<input value=\"{~ value || '#000000' }\" />",
		'{/with}',
	].join('\n');
	const dotted_style = [
		'<label for="{= props.attributes.name }">{= props.attributes.label }</label>',
		"<input value=\"{~ props.attributes.value || '#000000' }\" />",
	].join('\n');
	const call_site = `<input-color name="primary_color" label="Primary color" value="#ff0000"></input-color>`;

	const with_tag = find_ree_tag_at(call_site, 0);
	const dotted_tag = find_ree_tag_at(call_site, 0);
	assert.ok(with_tag);
	assert.ok(dotted_tag);

	const from_with = inline_component(with_style, with_tag);
	const from_dotted = inline_component(dotted_style, dotted_tag);

	assert.equal(from_with, from_dotted);
	assert.match(from_with, /<label for="primary_color">Primary color<\/label>/);
});

// A nested `{#with}` layers another object in front of the scope chain, so
// whether a bare name resolves to it or falls through to props.attributes
// depends on runtime shape. Skipping those bodies is correct either way.

test('leaves bare references inside a nested {#with} block untouched', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<h2>{= label }</h2>',
		'\t{#with address}',
		'\t\t<p>{= label }</p>',
		'\t{/with}',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<x-card label="Hi"></x-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /<h2>Hi<\/h2>/);
	assert.match(inlined, /\{#with address\}/);
	assert.match(inlined, /<p>\{= label \}<\/p>/);
});

test('leaves references shadowed by an {#each} binding untouched', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<h2>{= label }</h2>',
		'\t{#each roles as label}',
		'\t\t<span>{= label }</span>',
		'\t{/each}',
		'\t<p>{= label }</p>',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<role-list label="Roles"></role-list>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /<span>\{= label \}<\/span>/);
	assert.match(inlined, /<h2>Roles<\/h2>/);
	assert.match(inlined, /<p>Roles<\/p>/);
});

test('only substitutes bare names the call site actually passes', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<p>{= label }</p>',
		'\t<p>{= subtitle }</p>',
		"\t<p>{= 'label' }</p>",
		'\t<p>{= record.label }</p>',
		'\t<p>{= label(1) }</p>',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<x-card label="Hi"></x-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /<p>Hi<\/p>/);
	assert.match(inlined, /<p>\{= subtitle \}<\/p>/);
	assert.match(inlined, /<p>\{= 'label' \}<\/p>/);
	assert.match(inlined, /<p>\{= record\.label \}<\/p>/);
	assert.match(inlined, /<p>\{= label\(1\) \}<\/p>/);
});

test('expands every {#with props.attributes} block, not just the first', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<h2>{= label }</h2>',
		'{/with}',
		'<hr />',
		'{#with props.attributes}',
		'\t<p>{= label }</p>',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<x-card label="Hi"></x-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<h2>Hi</h2>\n<hr />\n<p>Hi</p>`);
});

test('expands a component mixing bare and dotted references', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t<h2>{= label }</h2>',
		'\t<p>{= props.attributes.label }</p>',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<x-card label="Hi"></x-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.equal(inlined, `<h2>Hi</h2>\n<p>Hi</p>`);
});

test('expands bare references inside {#switch} and {#case} directives', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t{#switch status}',
		'\t\t{#case active_status}',
		'\t\t\t<span>{= label }</span>',
		'\t\t{:else}',
		'\t\t\t<span>Off</span>',
		'\t{/switch}',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<status-pill status="pending" active_status="pending" label="Pending"></status-pill>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /\{#switch 'pending' \}/);
	assert.match(inlined, /\{#case 'pending' \}/);
	assert.match(inlined, /<span>Pending<\/span>/);
});

test('expands bare references inside {#if} directives', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t{#if is_admin}',
		'\t\t<span>Admin</span>',
		'\t{/if}',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<role-guard is_admin={= true }></role-guard>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	assert.match(inlined, /\{#if true \}/);
	assert.match(inlined, /<span>Admin<\/span>/);
});

test('expands bare references inside {#if} directives with plain string values', () => {
	const component_source = [
		'{#with props.attributes}',
		'\t{#if show_header}',
		'\t\t<header>Yes</header>',
		'\t{/if}',
		'{/with}',
	].join('\n');
	const tag = find_ree_tag_at(`<section-card show_header="yes"></section-card>`, 0);

	assert.ok(tag);
	const inlined = inline_component(component_source, tag);

	// Plain string values become JS string literals in directive expressions.
	assert.match(inlined, /\{#if 'yes' \}/);
});
