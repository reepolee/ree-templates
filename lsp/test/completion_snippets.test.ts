import { describe, expect, test } from "bun:test";
import type { CompletionItem } from "vscode-languageserver";

import { compute_completions } from "../src/features/completion";

describe("directive completion snippets", () => {
	test("replaces a typed opening brace before inserting an include", () => {
		const text = "<p>{</p>";
		const items = compute_completions(text, { line: 0, character: 4 });
		const include_item = find_item(items, "{#include}");

		expect(include_item.textEdit).toEqual({
			range: {
				start: { line: 0, character: 3 },
				end: { line: 0, character: 4 },
			},
			newText: "{#include('${1:path}') }",
		});
	});

	test("replaces a typed block prefix before inserting a block", () => {
		const text = "<p>{#</p>";
		const items = compute_completions(text, { line: 0, character: 5 });
		const if_item = find_item(items, "{#if}");

		expect(if_item.textEdit).toEqual({
			range: {
				start: { line: 0, character: 3 },
				end: { line: 0, character: 5 },
			},
			newText: "{#if $1}\n\t$0\n{/if}",
		});
	});
});

function find_item(items: CompletionItem[], label: string): CompletionItem {
	const item = items.find((candidate) => candidate.label === label);
	expect(item).toBeDefined();
	return item!;
}
