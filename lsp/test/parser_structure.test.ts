/**
 * Parser structural tests for .ree templates.
 */

import { describe, test, expect } from "bun:test";
import { scan } from "../src/parser/scanner";
import { parse } from "../src/parser/parser";
import type { AstNode } from "../src/parser/ast";

// Helper: scan + parse
function parse_src(source: string): AstNode {
	const tokens = scan(source);
	return parse(tokens).ast;
}

// Helper: find nodes by type recursively
function find_nodes(node: AstNode, type: string): AstNode[] {
	const result: AstNode[] = [];
	if (node.type === type) result.push(node);
	if (node.children) {
		for (const child of node.children) {
			result.push(...find_nodes(child, type));
		}
	}
	if (node.else_branch) {
		result.push(...find_nodes(node.else_branch, type));
	}
	return result;
}

describe("Parser", () => {
	describe("simple constructs", () => {
		test("plain HTML produces element with children", () => {
			const doc = parse_src("<div>Hello</div>");
			expect(doc.type).toBe("document");
			expect(doc.children!.length).toBe(1);
			expect(doc.children![0]!.type).toBe("element");
			expect(doc.children![0]!.tag_name).toBe("div");
		});

		test("output expression", () => {
			const doc = parse_src("{= props.name }");
			const outputs = find_nodes(doc, "output");
			expect(outputs.length).toBe(1);
			expect(outputs[0]!.prefix).toBe("=");
			expect(outputs[0]!.expression).toBe("props.name");
		});

		test("raw output expression", () => {
			const doc = parse_src("{~ raw_html }");
			const outputs = find_nodes(doc, "output");
			expect(outputs.length).toBe(1);
			expect(outputs[0]!.prefix).toBe("~");
		});

		test("translation tags", () => {
			const doc = parse_src("{_ ui.title }{- desc }{@ md }");
			const translations = find_nodes(doc, "translation");
			expect(translations.length).toBe(3);
			expect(translations[0]!.prefix).toBe("_");
			expect(translations[1]!.prefix).toBe("-");
			expect(translations[2]!.prefix).toBe("@");
		});

		test("raw JS block", () => {
			const doc = parse_src("{{ const x = 1; }}");
			const js = find_nodes(doc, "raw_js");
			expect(js.length).toBe(1);
		});

		test("include", () => {
			const doc = parse_src("{#include('partials/nav') }");
			const includes = find_nodes(doc, "include");
			expect(includes.length).toBe(1);
			expect(includes[0]!.path_value).toBe("partials/nav");
		});

		test("layout", () => {
			const doc = parse_src("{#layout('layouts/base') }");
			const layouts = find_nodes(doc, "layout");
			expect(layouts.length).toBe(1);
			expect(layouts[0]!.path_value).toBe("layouts/base");
		});
	});

	describe("block structures", () => {
		test("if block", () => {
			const doc = parse_src("{#if props.user}<div>yes</div>{/if}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(1);
			expect(blocks[0]!.block_type).toBe("if");
			expect(blocks[0]!.children!.length).toBeGreaterThan(0);
		});

		test("if/else block", () => {
			const doc = parse_src("{#if a }yes{:else}no{/if}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(2); // main block + else block
			const if_block = blocks.find(b => !b.recovery)!;
			expect(if_block!.block_type).toBe("if");
			expect(if_block!.else_branch).toBeDefined();
		});

		test("each block", () => {
			const doc = parse_src("{#each items as item }{= item }{/each}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(1);
			expect(blocks[0]!.block_type).toBe("each");
		});

		test("with block", () => {
			const doc = parse_src("{#with props.record }{= name }{/with}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(1);
			expect(blocks[0]!.block_type).toBe("with");
		});

		test("nested blocks", () => {
			const doc = parse_src("{#if a }{#each b as c }{= c }{/each}{/if}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(2);
			expect(blocks[0]!.block_type).toBe("if");
			expect(blocks[1]!.block_type).toBe("each");
		});

		test("switch block", () => {
			const doc = parse_src("{#switch props.status }{#case 10 }<p>ten</p>{:else}<p>other</p>{/switch}");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBeGreaterThanOrEqual(1);
			const sw = blocks.find(b => b.block_type === "switch")!;
			expect(sw).toBeDefined();
			expect(sw!.case_branches).toBeDefined();
			expect(sw!.case_branches!.length).toBe(1);
			expect(sw!.case_branches![0]!.condition).toBe("10");
			expect(sw!.else_branch).toBeDefined();
		});

		test("switch block with multiple cases", () => {
			const doc = parse_src("{#switch x }{#case 1 }one{#case 2 }two{/switch}");
			const blocks = find_nodes(doc, "block");
			const sw = blocks.find(b => b.block_type === "switch")!;
			expect(sw).toBeDefined();
			expect(sw!.case_branches!.length).toBe(2);
			expect(sw!.case_branches![0]!.condition).toBe("1");
			expect(sw!.case_branches![1]!.condition).toBe("2");
		});

		test("switch block with expression case", () => {
			const doc = parse_src("{#switch role }{#case 'admin' }Admin{#case 'user' }User{/switch}");
			const blocks = find_nodes(doc, "block");
			const sw = blocks.find(b => b.block_type === "switch")!;
			expect(sw).toBeDefined();
			expect(sw!.case_branches!.length).toBe(2);
			expect(sw!.case_branches![0]!.condition).toBe("'admin'");
		});
	});

	describe("components", () => {
		test("ReeTag component with children", () => {
			const doc = parse_src("<app-banner type='red'>{= msg }</app-banner>");
			const components = find_nodes(doc, "component");
			expect(components.length).toBe(1);
			expect(components[0]!.tag_name).toBe("app-banner");
			expect(components[0]!.attributes).toBe(" type='red'");
			expect(components[0]!.children!.length).toBeGreaterThan(0);
		});

		test("ReeTag self-closing component", () => {
			const doc = parse_src("<image-upload name='x' />");
			const components = find_nodes(doc, "component");
			expect(components.length).toBe(1);
			expect(components[0]!.self_closing).toBe(true);
		});
	});

	describe("recovery", () => {
		test("malformed input does not crash", () => {
			const doc = parse_src("{#if props.user\n  <div>{= props.user.name\n");
			expect(doc.type).toBe("document");
			// Should produce something, not crash
			expect(doc.children!.length).toBeGreaterThan(0);
		});

		test("mismatched block closer", () => {
			const doc = parse_src("{#if a }{/each}");
			// The {/each} closes the {#if} in recovery mode
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(1);
		});

		test("unclosed tag", () => {
			const doc = parse_src("<div>Hello");
			expect(doc.type).toBe("document");
			expect(doc.children!.length).toBeGreaterThan(0);
		});
	});

	describe("edge cases", () => {
		test("script block is not parsed as Ree", () => {
			const doc = parse_src("<script>const x = { open: true }</script>");
			const scripts = find_nodes(doc, "script");
			expect(scripts.length).toBe(1);
			// No output/translation nodes inside script
			const output = find_nodes(doc, "output");
			expect(output.length).toBe(0);
		});

		test("Windows newlines work", () => {
			const doc = parse_src("{#if a }\r\n{= x }\r\n{/if}");
			expect(doc.type).toBe("document");
			const blocks = find_nodes(doc, "block");
			expect(blocks.length).toBe(1);
		});

		test("nested HTML in blocks", () => {
			const doc = parse_src("<div>{#if a }<span>hi</span>{/if}</div>");
			const elements = find_nodes(doc, "element");
			expect(elements.length).toBeGreaterThanOrEqual(2);
		});

		test("component inside element", () => {
			const doc = parse_src("<div><app-banner>test</app-banner></div>");
			const components = find_nodes(doc, "component");
			expect(components.length).toBe(1);
			const elements = find_nodes(doc, "element");
			expect(elements.length).toBe(1);
		});

		test("include with space before paren", () => {
			// This is valid in the real compiler: {#include ('path')} won't work, but
			// {#include('path') } does.
			const doc = parse_src("{#include('partials/nav') }");
			const includes = find_nodes(doc, "include");
			expect(includes.length).toBe(1);
		});
	});
});
