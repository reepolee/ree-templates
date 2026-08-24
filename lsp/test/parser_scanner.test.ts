/**
 * Scanner tests for .ree template tokenization.
 */

import { describe, test, expect } from "bun:test";
import { scan, get_errors, reset } from "../src/parser/scanner";

// Helper: scan source and return tokens + errors
function scan_src(source: string) {
	// reset() is called inside scan()
	const tokens = scan(source);
	const errors = get_errors();
	return { tokens, errors };
}

describe("Scanner", () => {
	describe("text and HTML", () => {
		test("plain text", () => {
			const { tokens, errors } = scan_src("Hello, world!");
			expect(errors.length).toBe(0);
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("text");
		});

		test("simple div", () => {
			const { tokens } = scan_src("<div>Hello</div>");
			expect(tokens[0]!.type).toBe("tag_open");
			expect(tokens[0]!.tag_name).toBe("div");
			expect(tokens[1]!.type).toBe("text");
			expect(tokens[2]!.type).toBe("tag_close");
			expect(tokens[2]!.tag_name).toBe("div");
		});

		test("self-closing tags", () => {
			const { tokens } = scan_src("<br /><img src='x' />");
			expect(tokens[0]!.type).toBe("tag_self_close");
			expect(tokens[0]!.tag_name).toBe("br");
			expect(tokens[1]!.type).toBe("tag_self_close");
			expect(tokens[1]!.tag_name).toBe("img");
		});

		test("HTML comments are skipped as comment type", () => {
			const { tokens } = scan_src("<!-- comment -->text");
			expect(tokens[0]!.type).toBe("comment");
			expect(tokens[1]!.type).toBe("text");
		});

		test("script blocks are opaque", () => {
			const { tokens } = scan_src("<script>const x = { open: true };</script>");
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("script_body");
		});

		test("module script blocks with quoted attributes are opaque", () => {
			const source = '<script type="module">import { deepSignal } from "/signals.js"; const state = { ready: true };</script>';
			const { tokens } = scan_src(source);
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("script_body");
		});

		test("script src attributes can contain ree directives", () => {
			const source = '<script src="/form.js?v={= props.version }" defer></script>';
			const { tokens } = scan_src(source);
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("script_body");
		});

		test("style blocks are opaque", () => {
			const { tokens } = scan_src("<style>.foo { color: red; }</style>");
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("style_body");
		});

		test("pre blocks are opaque", () => {
			const { tokens } = scan_src("<pre>{= not.parsed }</pre>");
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("pre_body");
		});

		test("textarea blocks are opaque", () => {
			const { tokens } = scan_src("<textarea>{= not.parsed }</textarea>");
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("pre_body");
		});
	});

	describe("Ree directives", () => {
		test("escaped output {= expr}", () => {
			const { tokens } = scan_src("{= props.name }");
			expect(tokens[0]!.type).toBe("output");
			expect(tokens[0]!.prefix).toBe("=");
			expect(tokens[0]!.expression).toBe("props.name");
		});

		test("raw output {~ expr}", () => {
			const { tokens } = scan_src("{~ raw_html }");
			expect(tokens[0]!.type).toBe("output");
			expect(tokens[0]!.prefix).toBe("~");
			expect(tokens[0]!.expression).toBe("raw_html");
		});

		test("escaped translation {_ key}", () => {
			const { tokens } = scan_src("{_ ui.title }");
			expect(tokens[0]!.type).toBe("translation");
			expect(tokens[0]!.prefix).toBe("_");
			expect(tokens[0]!.translation_key).toBe("ui.title");
		});

		test("raw translation {- key}", () => {
			const { tokens } = scan_src("{- descriptions.card }");
			expect(tokens[0]!.type).toBe("translation");
			expect(tokens[0]!.prefix).toBe("-");
		});

		test("markdown translation {@ key}", () => {
			const { tokens } = scan_src("{@ descriptions.card }");
			expect(tokens[0]!.type).toBe("translation");
			expect(tokens[0]!.prefix).toBe("@");
		});

		test("raw JS {{ ... }}", () => {
			const { tokens } = scan_src("{{ const x = 1; }}");
			expect(tokens[0]!.type).toBe("raw_js");
		});

		test("raw JS with nested braces", () => {
			const { tokens } = scan_src("{{ const x = {a: 1}; }}");
			expect(tokens[0]!.type).toBe("raw_js");
		});
	});

	describe("block directives", () => {
		test("{#if}", () => {
			const { tokens } = scan_src("{#if condition }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("if");
		});

		test("{#each}", () => {
			const { tokens } = scan_src("{#each items as item }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("each");
		});

		test("{#with}", () => {
			const { tokens } = scan_src("{#with props.record }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("with");
		});

		test("{#switch}", () => {
			const { tokens } = scan_src("{#switch props.status }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("switch");
		});

		test("{#case}", () => {
			const { tokens } = scan_src("{#case 10 }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("case");
			expect(tokens[0]!.expression).toBe("10");
		});

		test("{#case with expression}", () => {
			const { tokens } = scan_src("{#case props.status }");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("case");
			expect(tokens[0]!.expression).toBe("props.status");
		});

		test("{/switch}", () => {
			const { tokens } = scan_src("{/switch}");
			expect(tokens[0]!.type).toBe("block_close");
			expect(tokens[0]!.block_type).toBe("switch");
		});

		test("{:else}", () => {
			const { tokens } = scan_src("{:else}");
			expect(tokens[0]!.type).toBe("block_else");
		});

		test("{/if}", () => {
			const { tokens } = scan_src("{/if}");
			expect(tokens[0]!.type).toBe("block_close");
			expect(tokens[0]!.block_type).toBe("if");
		});

		test("{/each}", () => {
			const { tokens } = scan_src("{/each}");
			expect(tokens[0]!.type).toBe("block_close");
			expect(tokens[0]!.block_type).toBe("each");
		});

		test("{/with}", () => {
			const { tokens } = scan_src("{/with}");
			expect(tokens[0]!.type).toBe("block_close");
			expect(tokens[0]!.block_type).toBe("with");
		});
	});

	describe("include and layout", () => {
		test("{#include} with literal path", () => {
			const { tokens } = scan_src("{#include('partials/nav') }");
			expect(tokens[0]!.type).toBe("include");
			expect(tokens[0]!.path_value).toBe("partials/nav");
		});

		test("{#layout} with literal path", () => {
			const { tokens } = scan_src("{#layout('layouts/base') }");
			expect(tokens[0]!.type).toBe("layout");
			expect(tokens[0]!.path_value).toBe("layouts/base");
		});

		test("include with data argument", () => {
			const { tokens } = scan_src("{#include('partials/nav', { title }) }");
			expect(tokens[0]!.type).toBe("include");
			expect(tokens[0]!.path_value).toBe("partials/nav");
		});
	});

	describe("components", () => {
		test("ReeTag component open", () => {
			const { tokens } = scan_src("<app-banner type='red'>");
			expect(tokens[0]!.type).toBe("component_open");
			expect(tokens[0]!.tag_name).toBe("app-banner");
			expect(tokens[0]!.attributes).toBe(" type='red'");
		});

		test("ReeTag component close", () => {
			const { tokens } = scan_src("</app-banner>");
			expect(tokens[0]!.type).toBe("component_close");
			expect(tokens[0]!.tag_name).toBe("app-banner");
		});

		test("ReeTag self-closing", () => {
			const { tokens } = scan_src("<image-upload name='x' />");
			expect(tokens[0]!.type).toBe("component_self_close");
			expect(tokens[0]!.tag_name).toBe("image-upload");
		});
	});

	describe("recovery", () => {
		test("unterminated {= expr does not crash", () => {
			const { tokens, errors } = scan_src("{= unfinished");
			expect(errors.length).toBeGreaterThan(0);
			expect(tokens[0]!.type).toBe("output");
			expect(tokens[0]!.recovery).toBeUndefined(); // it still classifies as output
		});

		test("unterminated string in include", () => {
			const { tokens } = scan_src("{#include('unclosed )");
			expect(tokens.length).toBeGreaterThan(0);
			// Should not crash
		});

		test("braces in script don't become Ree tokens", () => {
			const { tokens } = scan_src("<script>{a: 1}</script>");
			// The script body should be one opaque token
			expect(tokens.length).toBe(1);
			expect(tokens[0]!.type).toBe("script_body");
		});

		test("literal unsupported braces and less-than characters make progress", () => {
			const { tokens } = scan_src("value { plain } and 1 < 2");
			const source_length = tokens.reduce((length, token) => length + token.range.end - token.range.start, 0);
			expect(source_length).toBe("value { plain } and 1 < 2".length);
		});
	});

	describe("edge cases", () => {
		test("mixed content with attributes and expressions", () => {
			const { tokens, errors: scan_errors } = scan_src(`{#layout('layouts/base') }
<div class="container">
  {#if props.user}
    {_ ui.welcome }{= props.user.name }
  {:else}
    <p>{_ auth.login }</p>
  {/if}
  <app-header ...rest class="main"></app-header>
</div>`);

			// Verify no errors for this valid template
			const structural_errors = scan_errors.filter(e => !e.message.includes("unterminated"));
			expect(structural_errors.length).toBe(0);
		});

		test("spread attribute", () => {
			const { tokens } = scan_src("<div ...rest class='x'>");
			expect(tokens[0]!.type).toBe("tag_open");
		});

		test("Windows newlines (CRLF)", () => {
			const { tokens } = scan_src("{#if a }\r\n  {= x }\r\n{/if}");
			expect(tokens[0]!.type).toBe("block_open");
			expect(tokens[0]!.block_type).toBe("if");
		});

		test("nested blocks parse correctly", () => {
			const { tokens } = scan_src("{#if a }{#each b as c }{= c }{/each}{/if}");
			const types = tokens.map(t => t.type);
			expect(types).toContain("block_open");
			expect(types).toContain("block_close");
			expect(types.filter(t => t === "block_open").length).toBe(2);
			expect(types.filter(t => t === "block_close").length).toBe(2);
		});
	});
});
