import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const grammar = JSON.parse(
	await readFile(new URL('../syntaxes/ree.tmLanguage.json', import.meta.url), 'utf8')
);

test('highlights {@ key } as a translation tag', () => {
	const translationPatterns = grammar.repository['ree-tags'].patterns.filter(
		pattern => pattern.name === 'meta.embedded.translation.ree'
	);

	const markdownPattern = translationPatterns.find(pattern => pattern.begin === '\\{@');

	assert.ok(markdownPattern, 'expected a translation grammar rule for {@ ... }');
	assert.deepEqual(markdownPattern.patterns, [
		{
			name: 'string.unquoted.ree.translation-key',
			match: '[\\w.]+(?=\\s*\\})',
		},
	]);
});
