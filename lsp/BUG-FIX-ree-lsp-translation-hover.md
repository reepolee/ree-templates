# ree-lsp translation hover bug investigation

## 1. Bug Summary

The standalone `ree-lsp` process starts and passes its current protocol tests, but real `reepolee-dev` templates can make feature requests hang. Translation hover in `ree-templates` is therefore unavailable or appears to stop working.

There are four related defects:

1. The scanner can stop making progress on real template content. A `<script>` opening tag with quoted attributes is skipped incorrectly. The JavaScript body is then scanned as template text, and an ordinary JavaScript `{` leaves the scanner in an infinite loop.
2. Translation hover caches a namespace-resolved index only by locale file path. The first route hovered contaminates later route hovers.
3. Hover explicitly limits output to 10 locales, which contradicts the requirement to show all translations.
4. The VS Code extension defaults to launching `bun run src/server.ts --stdio` without locating `ree-lsp`. The packaged VSIX does not contain the language server. It works only when a user supplies a valid `ree.server.cwd` or another external installation path.

Severity is high for editor functionality. The database and runtime translation system are not affected.

## 2. Evidence Collected

### Runtime observations

- `bun run typecheck` and all 72 current `ree-lsp` tests pass.
- `npm run check-types` and all 23 current `ree-templates` tests pass.
- A direct `compute_hover()` call on `routes/examples/kitchen_sink/kitchen_sink.ree` does not return.
- The manual protocol hover reaches initialization and diagnostics, then waits indefinitely for hover.
- Scanning the kitchen sink template succeeds through line 114 and hangs as soon as line 115 is included:

```ree
<script type="module">
    import { deepSignal, watchEffect } from "/alien-deepsignals.min.js";
```

- Starting the extension's default command from `ree-templates/` fails with `Module not found "src/server.ts"`.
- `ree-templates-1.1.11.vsix` contains `dist/extension.js` but no `ree-lsp` server entry.

### Suspicious code

- `src/parser/scanner.ts:534-543`: `skip_tag()` stops at a closing quote but does not move its local index past that quote. It can skip the real opening-tag `>` and fail to recognize the script body as opaque.
- `src/parser/scanner.ts:633-645`: `scan_text()` stops immediately on `{` or `<`. When none of the specialized scanners accept that character, the main loop retries at the same position forever.
- `src/features/hover.ts:162-167`: cache entries use only `full_path`, although `load_translation_index()` depends on `from_ree_file` and its route namespace.
- `src/features/hover.ts:120`: `values.slice(0, 10)` drops locales beyond the first 10.
- `src/features/hover.ts:26-28` and `src/features/completion.ts:28-31`: cache invalidators exist but are not called by the server.
- `ree-templates/src/lsp_client.ts:59`: default arguments refer to `src/server.ts` while no default server working directory is resolved.

### Namespace contamination reproduction

After clearing the hover cache:

1. Hovering `ui.title` in `routes/home/home.ree` returns `Home Page` and `Domaca stran`.
2. Hovering `ui.title` in `routes/examples/kitchen_sink/kitchen_sink.ree` incorrectly returns the same home values.
3. Clearing the cache and hovering the kitchen sink first correctly returns `Kitchen Sink` and `Kuhinjsko korito`.

This proves the cache key is missing route context.

### Test coverage gap

Existing scanner fixtures cover simple `<script>` blocks but not script opening tags with quoted attributes. Existing protocol tests do not exercise translation hover against a real project root. The manual hover script is not part of the test suite and its message reader can discard buffered protocol frames.

## 3. Root Cause Hypothesis

### High confidence

The primary hang is a scanner progress bug. `skip_tag()` mishandles quoted attributes, so the script scanner does not reliably consume the opaque module script. Later, the generic scanner reaches an ordinary JavaScript object or import brace. No scanner accepts it and `scan_text()` consumes zero characters. The outer scan loop cannot terminate.

The route-specific translation error is caused by caching a derived, namespace-specific translation map under a namespace-independent locale-file key.

The missing locales are caused by the explicit 10-item slice.

The extension's default launch path cannot work in a packaged installation because the server is neither bundled nor installed at the configured relative path.

### Medium confidence

Users may see stale translation values after `.reepolee/i18n/*.json` is regenerated. The extension creates a file watcher, but the server does not handle `workspace/didChangeWatchedFiles` and its caches do not validate modification times.

### Uncertain

The intended distribution model for `ree-lsp` is not finalized. A development-only sibling-folder lookup would work in this workspace but would not be portable. Bundling the server with the extension or installing a stable `ree-lsp` executable are safer long-term choices.

## 4. Affected Systems

- `ree-lsp/src/parser/scanner.ts`
- `ree-lsp/src/parser/contexts.ts` consumers: hover and definition
- `ree-lsp/src/features/hover.ts`
- `ree-lsp/src/features/completion.ts` cache lifecycle
- `ree-lsp/src/server.ts` watched-file handling
- `ree-templates/src/lsp_client.ts`
- `ree-templates/package.json` server configuration defaults
- `ree-templates` VSIX packaging
- `reepolee-dev/.reepolee/i18n/*.json` as read-only editor exports only

No database tables, runtime routes, or translation source data need changes.

## 5. Fix Strategy

### P0: make scanner progress guaranteed

- Correct `skip_tag()` so it advances beyond a matched closing quote and continues parsing the actual opening tag.
- Add a no-progress guard to the main scanner loop or make `scan_text()` consume one literal character when it starts on an unrecognized `{` or `<`.
- Keep script, style, pre, and textarea bodies opaque.
- Add regression tests for:
  - `<script type="module">` containing imports and object literals.
  - `<script src="...">` with template directives inside an attribute.
  - literal unmatched `{` and `<` text.
  - the production kitchen sink template.

### P0: isolate translation hover by route

- Key hover cache entries by locale file plus the source `.ree` file or normalized route namespace, matching the working completion-cache approach.
- Add a regression test that hovers the same key in two route namespaces without clearing the cache.

### P0: make extension startup real

- Decide and implement one portable server distribution contract.
- Preferred: include a runnable server artifact in the VSIX and derive its absolute path from `ExtensionContext.extensionUri`.
- Alternative: publish/install a stable `ree-lsp` executable and use that executable as the extension default.
- Do not silently assume a sibling `../ree-lsp` folder in production. A sibling lookup may be retained only as an explicit development option.
- Preserve configurable command, arguments, and working directory overrides.

### P1: show every locale and refresh exports

- Remove the 10-locale truncation from hover.
- Sort locale filenames for deterministic display. If a configured default locale is sent to the server later, display it first without excluding any others.
- Register watched-file changes in the server and clear both hover and completion translation caches when `.reepolee/i18n/*.json` changes, or validate cache entries with file modification times.

### P1: protocol coverage

- Convert the manual translation hover scenario into an automated protocol test with a real `rootUri` and real `reepolee-dev` fixture paths.
- Fix the protocol reader so it retains unread buffered frames.
- Verify one VS Code hover request produces one hover result and no duplicate client-side provider is registered.

## 6. Risks

- A generic no-progress guard must preserve literal characters rather than hiding malformed input.
- Scanner changes affect diagnostics, hover, definitions, symbols, and folding because they share the token stream.
- Cache keys based on full source paths use more memory than namespace keys, but the number of open project templates is bounded and acceptable. A normalized namespace key is preferable if exposed by the profile.
- Removing the locale cap can create a large hover for projects with many locales. This is required behavior, but formatting should stay compact.
- Bundling a Bun-targeted server in a VSIX adds packaging and cross-platform path concerns. Windows, macOS, and Linux launch behavior must be checked.
- The working trees already contain uncommitted LSP integration changes. Implementation must preserve those edits and avoid rewriting unrelated extension code.

## Prioritized TODO Checklist

- [ ] P0 fix `skip_tag()` quoted-attribute handling.
- [ ] P0 guarantee scanner cursor progress for unrecognized `{` and `<`.
- [ ] P0 add realistic scanner and hover regression tests.
- [ ] P0 key hover translation caches by locale file plus route context.
- [ ] P0 implement a portable extension-to-server launch contract.
- [ ] P1 remove the 10-locale hover limit.
- [ ] P1 invalidate translation caches when editor export files change.
- [ ] P1 automate the real-project protocol hover test.
- [ ] Re-scan touched files for Bun, naming, temp-variable, minimal-change, cross-platform, and ASCII punctuation rules before completion.
