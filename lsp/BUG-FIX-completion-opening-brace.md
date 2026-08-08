# Bug: directive completion duplicates the opening brace

## 1. Bug Summary

Selecting a Ree directive completion after typing a single opening brace inserts
another opening brace. For example, selecting the include snippet in
`<p>{</p>` produces `<p>{{#include('path') }</p>` instead of
`<p>{#include('path') }</p>`.

This affects every directive snippet offered immediately after `{`, including
blocks, output forms, translations, layouts, and includes. The malformed syntax
is deterministic and makes the selected completion invalid.

## 2. Evidence Collected

- `src/features/completion.ts` detects the exact context after an opening brace
  with `is_after_open_brace`.
- The same module returns the directive snippets through `to_completion_item`.
- Directive insert text includes its own opening brace. The include snippet is
  `{#include('${1:path}') }`.
- Completion items have no LSP `textEdit` or replacement range, so VS Code
  inserts the full snippet at the cursor and preserves the already typed `{`.
- There is no completion regression test for selecting a directive immediately
  after a brace.

## 3. Root Cause Hypothesis

High confidence: context recognition and insertion behavior disagree. The
server recognizes that the user has already typed `{`, but supplies snippets
designed for an empty location.

The LSP client correctly treats the result as a snippet. VS Code therefore
expands the supplied snippet exactly at the cursor, resulting in two braces.
The server must either replace the typed opening brace or supply an insertion
that starts after it.

## 4. Affected Systems

- `ree-lsp/src/features/completion.ts`
- All directive snippet completions returned after a single `{`
- The bundled language server in the `ree-templates` VSIX after it is rebuilt

Translation-key and helper completions are not affected because they are
offered after their tag prefix or inside an existing expression.

## 5. Fix Strategy

Preferred fix: retain the full, self-contained snippet definitions and return a
completion `textEdit` whose replacement range begins at the opening brace when
the cursor is immediately after `{` (or a directive prefix such as `{#`). This
makes the selected completion replace the partial syntax rather than append to
it.

The range must be derived from the document position and only apply to snippet
items offered in the brace context. Keep helper and translation-key completion
insertion behavior unchanged. Add regression tests for a plain `{` followed by
an include and a block snippet, including the expected replacement range.

## 6. Risks

- Replacing too wide a range could erase a typed directive prefix such as `{#`.
- Applying the range to translation-key completion would replace valid text.
- The generated VSIX must be rebuilt after the server fix; otherwise users
  keep the existing bundled server.

## 7. TODO Checklist

- [ ] Add completion-context data for the partial directive start.
- [ ] Return a range-aware `textEdit` for directive snippets in that context.
- [ ] Add completion regression tests for `{` plus include and block snippets.
- [ ] Run LSP tests and rebuild the VSIX.
