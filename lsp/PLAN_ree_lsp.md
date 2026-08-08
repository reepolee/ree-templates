# Plan: Standalone `.ree` Language Server (`ree-lsp`)

**Status:** Planning only  
**Primary target:** `reepolee-dev`  
**Future target:** `ree-web` SSG profile  
**Package location:** new top-level sibling package `ree-lsp/`  
**First milestone:** structural `.ree` intelligence; embedded JavaScript/TypeScript intelligence is explicitly deferred

This document is the implementation contract for coding agents. Agents must read it before modifying files and must keep changes inside the workstream and milestone assigned to them.

---

## 1. Repository and scope rules

### 1.1 Source of truth

The canonical `.ree` semantics are in:

- `reepolee-dev/lib/template/compiler.ts`
- `reepolee-dev/lib/template/custom_elements.ts`
- `reepolee-dev/lib/template/include_resolver.ts`
- `reepolee-dev/lib/template/helper_names.ts`
- `reepolee-dev/internals/REE_TEMPLATES.md`

`ree-web/lib/template/` is the SSG/reference mirror. Do not modify the mirror while implementing the first milestone unless a follow-up task explicitly requests synchronization.

The existing VS Code extension is in `ree-templates/`. It contains useful editor behavior and project conventions, but it is VS Code API-specific and is not the language server implementation.

`reettier/` is the formatter. `reesql/` is unrelated to this LSP and is out of scope.

### 1.2 Actual `.ree` syntax

Do not implement the generic syntax from the initial proposal (`@if`, `@each`, etc.). The first server must recognize the syntax used by the real compiler:

```ree
{= expression }                       escaped output
{~ expression }                       raw output
{_ translation.key }                  escaped translation
{- translation.key }                  raw translation
{@ translation.key }                  markdown translation
{{ const value = ... }}               raw JavaScript block

{#if condition } ... {:else} ... {/if}
{#each list as item } ... {:else} ... {/each}
{#with expression } ... {/with}

{#include("partials/nav") }
{#layout("layouts/base") }

<component-name>...</component-name>  ReeTag component
```

HTML, attributes, spread attributes (`...expr`), `<script>`, `<style>`, comments, `<pre>`, `<textarea>`, and fenced code examples must be tolerated. A tag containing a hyphen is a ReeTag component; a hyphen-less tag is ordinary HTML.

### 1.3 Non-goals for milestone 1

Do **not**:

- execute or render templates;
- call `new Function()` or evaluate user JavaScript;
- connect to the Reepolee database;
- write translation JSON or mutate project files from diagnostics/code actions;
- implement a Tree-sitter grammar;
- build a TypeScript language-service bridge or virtual-document source maps;
- implement a full HTML/JS/CSS language server;
- modify `ree-web` runtime code;
- fold the LSP into the HTTP server or MCP server.

The server is a standalone stdio process and must be safe to run against incomplete, untrusted editor buffers.

---

## 2. Desired package layout

Create a new package at the workspace root:

```text
ree-lsp/
  package.json
  tsconfig.json
  README.md
  src/
    server.ts
    protocol.ts                 # shared LSP/server wiring types if needed
    documents/
      document_store.ts
      positions.ts
    parser/
      ast.ts
      scanner.ts
      parser.ts
      diagnostics.ts
      contexts.ts
    project/
      profile.ts
      project_root.ts
      paths.ts
      symbols.ts
      translations.ts
      components.ts
    formatter/
      reettier.ts
    features/
      completion.ts
      definition.ts
      diagnostics.ts
      folding.ts
      hover.ts
      symbols.ts
      formatting.ts
    profiles/
      reepolee_dev.ts
      index.ts
  test/
    parser_scanner.test.ts
    parser_structure.test.ts
    project_paths.test.ts
    features.test.ts
    lsp_protocol.test.ts
    fixtures/
      valid/
      incomplete/
      invalid/
```

The exact split may be adjusted if the implementation remains modular. Do not put all parsing and feature logic in `server.ts`.

### 2.1 Package/workspace and dependency setup

`ree-lsp/` is a standalone top-level package, not an importable submodule of `reepolee-dev`. The repository root currently contains multiple independent Bun/npm/Rust projects, so the package agent must explicitly choose and document one of these supported setups before implementation:

- a self-contained `ree-lsp/package.json` with its own lockfile; or
- a deliberately configured root workspace that includes `ree-lsp` without changing unrelated packages.

Do not assume the root `package.json` is already a workspace. Do not modify an existing project lockfile just to make the new package convenient. Record the chosen install/run commands in `ree-lsp/README.md`.

Use Bun and strict TypeScript, consistent with the surrounding Bun repositories. Before adding dependencies, verify exact versions, Bun compatibility, and licensing against official documentation and the package manifests/lockfiles. The dependency setup milestone is incomplete until the chosen versions and resulting lockfile/install strategy are reproducible.

Preferred protocol libraries:

- `vscode-languageserver`
- `vscode-languageserver-textdocument`

Use stdio transport. All LSP messages go to stdout. Logs and formatter errors go to stderr. Never use `console.log` for debugging in the server.

Suggested scripts:

```json
{
  "dev": "bun run src/server.ts --stdio",
  "typecheck": "tsc --noEmit",
  "test": "bun test"
}
```

The package must not require the application server to be running.

---

## 3. Architecture contract

### 3.1 Server lifecycle

Implement the standard LSP lifecycle:

1. create a stdio connection;
2. register `initialize` and `initialized` handlers;
3. advertise incremental or full synchronization according to the document manager actually used;
4. maintain open document text/version in memory;
5. parse and publish diagnostics on open and change;
6. remove document state and diagnostics on close;
7. shut down cleanly on `shutdown`/`exit`.

Initial capabilities should cover only implemented features:

- text document synchronization;
- completion;
- hover;
- definition;
- document symbols;
- folding ranges;
- document formatting.

Diagnostics are delivered through `textDocument/publishDiagnostics`; they are not a server capability to advertise as a separate item. Do not advertise completion, hover, definitions, symbols, folding, or formatting until the corresponding handler and tests are complete.

Do not advertise a feature before its handler and tests are complete.

### 3.2 Document model

`DocumentStore` must provide:

- URI/path normalization;
- current text and version;
- conversion between LSP `Position` and source offsets;
- line-start lookup;
- parsed-document caching keyed by document version;
- invalidation after changes;
- safe handling of `file://` URIs and Windows paths.

Use offsets compatible with LSP UTF-16 positions. Add tests containing non-ASCII text before a template construct so position mapping cannot accidentally be byte- or Unicode-code-point-based.

### 3.3 Tolerant scanner/parser

Build a source-preserving scanner first, then a structural parser over scanner tokens. The scanner must never throw for normal incomplete editor input.

Scanner responsibilities:

- identify HTML open/close/self-closing tags while respecting quoted attributes;
- identify Ree tags by prefix and preserve exact start/end offsets;
- identify `{#...}`, `{:else}`, `{/...}` block tags;
- identify output and translation tags;
- identify raw `{{...}}` blocks without trying to validate arbitrary JavaScript;
- identify include/layout literal paths when available;
- identify comments, script/style bodies, pre/textarea bodies, and fenced code as opaque regions where appropriate;
- identify attribute expressions and spreads enough for context/completion;
- recover from unterminated braces, quotes, tags, strings, and blocks.

Parser responsibilities:

- produce a lossless/tolerant AST or equivalent node index;
- track block nesting and parent/child relationships;
- record `if`/`each`/`with` scopes and `else` branches;
- record include/layout/component references;
- record translation references;
- record document symbols and foldable ranges;
- retain malformed nodes with recovery markers rather than dropping the rest of the document.

The parser must not reinterpret arbitrary braces in CSS, JavaScript, comments, fenced code, or quoted text as Ree directives.

### 3.4 Project profile

Introduce a profile interface so project-specific behavior is not hard-coded into every feature. The first implementation is `reepolee-dev`. Profile discovery, filesystem/path resolution, component indexing, and translation indexing belong to one profile/filesystem workstream. That workstream must publish stable, dependency-light interfaces before diagnostics, completion, or navigation agents begin feature implementation:

```text
profile.ts + paths.ts → components.ts / translations.ts → feature consumers
```

The profile agent owns those shared interfaces and their tests; feature agents must not independently scan the project or reinterpret path/translation semantics.


```ts
type ReeProjectProfile = {
  name: "reepolee-dev";
  findProjectRoot(filePath: string): string | undefined;
  routeRoots: string[];             // routes/
  componentRoots: string[];         // components/
  translationRoots: string[];       // .reepolee/i18n/ read-only editor export
  resolveInclude(...): ResolvedTarget | undefined;
  resolveLayout(...): ResolvedTarget | undefined;
  resolveComponent(...): ResolvedTarget | undefined;
  loadTranslationIndex(...): TranslationIndex;
  helperNames: readonly string[];
};
```

Project root discovery should walk upward from the document directory and use clear markers (for example `.git`, `package.json`, `routes`, `components`) without assuming the current working directory is the project root. All filesystem resolution must use `path.join`/`path.resolve` and must reject traversal outside the relevant project root.

Profile detection should degrade gracefully for an unsaved document or a folder that is not recognized as a Reepolee project. Structural features must still work without a project profile.

### 3.5 Path semantics

Match the behavior of `reepolee-dev/lib/template/include_resolver.ts`, not this summary alone. The profile agent must write table-driven tests against the real resolver rules and explicitly document any intentional LSP-only difference:

- `$components/name` -> project `components/`;
- `$routes/name` -> project `routes/`;
- `$lib/name` -> project `lib/`;
- `./name` and `../name` -> relative to current template;
- `/name` and bare names -> views/routes-root semantics;
- explicit `.ree` -> template target;
- non-`.ree` explicit extension -> raw target, but do not offer executable/rendering behavior;
- traversal outside the relevant base is rejected.

The LSP may use a pure, non-rendering resolver rather than importing the runtime resolver, but its observable path decisions must be covered by parity tests. Do not copy approximate semantics into several feature modules.

Definitions and diagnostics must distinguish:

- a syntactically valid reference whose target is missing;
- a dynamic/non-literal path that cannot be statically resolved;
- a path intentionally outside the current profile's known roots.

Never read arbitrary paths supplied by a template outside approved roots.

### 3.6 Translation semantics

For `reepolee-dev`, translations are DB-first. `.reepolee/i18n/*.json` is a read-only editor export, not a write target and not the runtime source of truth.

The LSP may read the export for completion, hover, definitions, and warnings when present. It must:

- never offer “create key” or write-back quick fixes in DB mode;
- tolerate absent/stale exports;
- avoid treating a missing export as proof that a key is invalid;
- use the same dotted key semantics as `{_}`, `{-}`, and `{@}`;
- avoid assuming all locales contain identical keys.

A future `ree-web` profile may read local JSON translations, but that profile is not part of milestone 1.

---

## 4. Feature milestones

### Milestone 0 — package shell and protocol smoke test

**Owner:** server/package agent

Tasks:

1. Create `ree-lsp/package.json`, `tsconfig.json`, README, and source/test directories.
2. Add and verify the LSP dependencies.
3. Implement a minimal stdio server with `initialize`, shutdown, and document synchronization.
4. Add a protocol smoke test that starts the server, sends initialize/open/shutdown messages, and verifies valid JSON-RPC framing.
5. Document how to run it from a `reepolee-dev` workspace.

Acceptance criteria:

- package typechecks;
- `bun test` passes;
- server emits no non-protocol stdout;
- initialize advertises only implemented capabilities;
- no application server or database is started.

### Milestone 1 — scanner and tolerant structural parser

**Owner:** parser agent

Tasks:

1. Define AST/token types with source ranges and recovery metadata.
2. Implement scanner states for markup, Ree tags, quoted attributes, opaque bodies, and embedded raw blocks.
3. Implement tolerant block matching for `if`, `each`, `with`, and `else`.
4. Parse literal include/layout paths and component tag names.
5. Add fixtures for valid, nested, malformed, and incomplete templates.
6. Ensure parse results are source-preserving enough for precise diagnostics and feature ranges.

Required cases:

```ree
{#if props.user}
  <div>{= props.user.name}</div>
{:else}
  <p>{_ auth.login}</p>
{/if}
```

```ree
{#each props.items as item, index, key}
  <item-card ...item>{= item.name}</item-card>
{/each}
```

```ree
<script>
  const x = { open: true };
</script>
```

```ree
{#if props.user
  <div>{= props.user.name
```

Acceptance criteria:

- malformed input never crashes the server;
- nested block and HTML ranges are correct;
- braces in strings/comments/script/style/fences do not create false Ree nodes;
- parser tests cover Windows newlines and Unicode before ranges;
- parser has no runtime evaluation of embedded code.

### Milestone 2 — structural diagnostics

**Owner:** diagnostics agent

Tasks:

1. Publish parser diagnostics on open/change.
2. Report unmatched/mismatched block closers, unclosed blocks, duplicate `{:else}`, malformed directive shapes, and unterminated recognized tags.
3. Report unresolved literal include/layout/component targets only when a recognized `reepolee-dev` project profile is available.
4. Report unknown translation keys only when a usable translation index is available; use warning severity and explain the export limitation.
5. Deduplicate overlapping diagnostics and keep ranges small/useful.
6. Add diagnostic codes/source strings suitable for clients.

Acceptance criteria:

- valid existing templates produce no structural errors;
- an incomplete buffer produces actionable diagnostics, not cascades over the entire file;
- missing profile or missing translation export does not create false-positive project diagnostics;
- diagnostics update after an in-memory text change without writing the file.

### Milestone 3 — structural completion

**Owner:** completion agent

Tasks:

1. Detect completion context from the parsed document and cursor position.
2. Offer block/directive snippets for `{#if}`, `{#each}`, `{#with}`, `{#include}`, `{#layout}`, `{:else}`, and matching closers.
3. Offer output/translation tag forms where appropriate.
4. Offer built-in helper names from `reepolee-dev/lib/template/helper_names.ts`.
5. Offer translation keys from the read-only export only inside translation tags.
6. Offer component names from `components/*.ree` and path completions for include/layout literals.
7. Replace only the partial token/range; do not duplicate braces or surrounding text.

Acceptance criteria:

- completion is context-sensitive (translation keys do not appear as HTML tags, and block snippets do not appear inside quoted attributes);
- component/path completion is unavailable rather than unsafe when project root is unknown;
- snippets produce the actual `.ree` syntax;
- completion tests cover cursor at end, cursor in middle, and incomplete tags.

### Milestone 4 — definitions, hover, symbols, and folding

**Owner:** navigation agent

Tasks:

1. Go to definition for literal includes and layouts.
2. Go to definition for hyphenated component tags.
3. Go to definition for translation keys when an export file and precise key location are available.
4. Add hover documentation for Ree constructs, helper names, translation values, and resolved project targets.
5. Add document symbols for Ree blocks, components, includes, and layouts. Keep HTML symbols out of v1 unless the scanner already exposes them without adding a separate HTML parser.
6. Add folding ranges for Ree blocks, script/style bodies, and comments. HTML element folding is optional in v1 and must not expand the scope into a standalone HTML parser.
7. Return `undefined` instead of guessing when a target is dynamic or ambiguous.

Acceptance criteria:

- definition URIs are normalized and point to real files/ranges;
- hover does not read or execute arbitrary template expressions;
- symbols/folds remain usable on incomplete documents;
- translation definition never proposes a DB write or edit.

### Milestone 5 — formatter integration

**Owner:** formatter agent

Tasks:

1. Invoke existing `reettier` through stdin, using the project root as `cwd`.
2. Support configurable executable path with a safe default of `reettier` on PATH; document that the executable is an external trusted tool and do not construct shell command strings.
3. Define executable discovery, missing-binary errors, a bounded timeout, cancellation behavior, and maximum captured stderr/stdout sizes.
4. Return one full-document `TextEdit` only when formatted output differs and only for the document version used to run the formatter.
5. Capture stderr and non-zero exit status as an LSP error/log without corrupting stdout.
6. Decide and document whether the LSP uses default mode only; expose `--full` only if a client setting/command is deliberately added.
7. Add tests with a fake formatter process or a controlled executable path; do not depend on a developer’s globally installed binary for unit tests.

Acceptance criteria:

- formatting preserves source when the formatter fails;
- formatter receives the exact current in-memory document;
- formatter runs from the detected project root;
- no shell string interpolation is used for document content or executable arguments;
- formatter integration is covered by success, failure, and unchanged-output tests.

### Milestone 6 — VS Code client integration

**Owner:** editor integration agent; only after milestones 0–5 stabilize

Tasks:

1. Add a minimal LSP client launch path to `ree-templates` for language id `ree`.
2. Before enabling each LSP capability, inventory the existing VS Code providers in `ree-templates/src/` and define an explicit migration matrix: retain, disable, or replace. Do not leave duplicate diagnostics/completion/hover/definition providers active accidentally.
3. Add compatibility tests or a manual protocol checklist proving that one user action produces one effective result after migration.
4. Pass the workspace root and formatter configuration to the server through initialization/settings.
5. Preserve existing `reettier` commands and ReeTag expansion unless intentionally migrated.
6. Add a README setup/troubleshooting section.

Do not make the VS Code extension a hard dependency of the standalone server. The server must remain usable by Neovim, Helix, Zed, and other clients.

### Milestone 7 — `ree-web` profile and embedded language follow-up

These are separate follow-up milestones, not prerequisites for the first release:

- add `ree-web` project detection and `src/public`/`src/components` path conventions;
- add local JSON translation indexing for SSG projects;
- add client setup recipes for Neovim, Helix, and Zed;
- design virtual JS/TS and HTML projections only after structural parsing, offsets, and path resolution have proven stable;
- evaluate whether TypeScript language-service delegation is worth its dependency and source-map complexity.

---

## 5. Agent work allocation and dependency graph

Agents may work in parallel only when their changes do not depend on unfinished APIs:

```text
package/protocol shell
        ↓
scanner + AST types ───────┐
        ↓                  │
parser + project profile ──┼── diagnostics
        ↓                  ├── completion
        └───────────────────┼── definition/hover/symbols/folding
                            └── formatter integration
                                      ↓
                             protocol/integration tests
                                      ↓
                             VS Code client migration
```

Recommended assignments:

- **Agent A — package/server:** package shell, protocol lifecycle, document store.
- **Agent B — parser:** scanner, AST, recovery, parser fixtures.
- **Agent C — profile/filesystem:** root detection, path resolution, component and translation indexes.
- **Agent D — diagnostics/completion:** structural features once AST/context APIs are stable.
- **Agent E — navigation:** definitions, hover, symbols, folding.
- **Agent F — formatter:** reettier subprocess adapter and tests.
- **Agent G — integration/review:** protocol tests, package README, client integration after the standalone server is stable.

Before editing exported symbols, search all `ree-lsp` references and update consumers/tests. Keep shared types dependency-light so parser tests do not need to start an LSP connection.

---

## 6. Testing strategy

### 6.1 Unit tests

Cover:

- scanner token boundaries and recovery;
- nested/mismatched block parsing;
- literal path parsing and traversal rejection;
- project root detection from nested route/component files;
- translation key flattening and stale/missing export behavior;
- UTF-16 position conversion;
- completion context and replacement ranges;
- diagnostic severity/ranges/codes;
- definition target selection;
- fold/symbol ranges;
- formatter command argument construction and failures.

### 6.2 Protocol tests

Exercise real JSON-RPC framing over stdio:

1. initialize;
2. initialized;
3. didOpen with valid template;
4. receive diagnostics;
5. completion/hover/definition/formatting request;
6. didChange with incomplete template;
7. verify updated diagnostics/features;
8. didClose;
9. shutdown/exit.

Tests must assert that stdout contains only valid protocol frames. Stderr may contain logs.

### 6.3 Fixture matrix

Include at least:

- plain HTML;
- all output/translation forms;
- nested `if`/`each`/`with` and `else`;
- literal and dynamic includes/layouts;
- hyphenated components and regular HTML tags;
- multiline attributes and spreads;
- script/style, comments, pre/textarea, fenced code;
- unterminated braces/quotes/tags/blocks;
- missing include/component/translation export;
- Windows path separators and Unicode content;
- generated CRUD-style templates from `reepolee-dev`.

### 6.4 Repository validation

For the new package:

```text
bun install                 # only when dependency setup is intentionally being performed
bun run typecheck
bun test
```

For `ree-templates` changes, run its documented typecheck/package checks. For `reepolee-dev`, do not run the full application/database test suite merely to validate the standalone package unless an integration change touches that application. Never run production/deployment commands as part of validation.

---

## 7. Security and reliability requirements

- Never evaluate template expressions or execute a template as part of parsing or completion.
- Never trust include/layout/component paths from unsaved buffers without root and traversal checks.
- Do not load arbitrary files based on dynamic expressions.
- Do not connect to the database from the LSP.
- Do not write translation files or source files from diagnostics.
- Bound filesystem scans and avoid recursively traversing `node_modules`, build output, databases, or hidden cache directories.
- Catch parser and feature errors per request so one malformed document cannot terminate the server.
- Keep protocol output isolated from logs and child-process output.
- Handle cancellation and stale document versions where practical; never return edits computed from an older document version without checking the current version.

---

## 8. Definition of done for the first release

The first release is complete only when all of the following are true:

- `ree-lsp` is independently installable/runnable with Bun;
- it supports `reepolee-dev` structural `.ree` files without starting the app;
- valid and incomplete templates parse without crashes;
- structural diagnostics are useful and low-noise;
- completions use real `.ree` syntax and project data safely;
- literal includes/layouts/components and available translation keys navigate correctly;
- hover, symbols, and folding work on recovered ASTs;
- formatting delegates to `reettier` safely;
- protocol, parser, feature, path, and formatter tests pass;
- the README explains standalone use and the current limitations;
- no `ree-web` runtime files, DB code, generated routes, or unrelated `reesql` code were changed;
- embedded TypeScript intelligence is explicitly documented as future work rather than silently approximated.

---

## 9. Review checklist for every agent PR/change

Before handing off:

- [ ] Read the relevant `AGENTS.md` and current source files.
- [ ] Keep changes within the assigned workstream.
- [ ] Add or update tests for every new parser/feature behavior.
- [ ] Confirm exact source ranges with Unicode and incomplete-input cases.
- [ ] Confirm no user code is executed.
- [ ] Confirm no DB/file writes are introduced.
- [ ] Confirm Windows and POSIX path behavior.
- [ ] Run package typecheck and focused tests.
- [ ] Report changed files, tests run, known limitations, and follow-up work.

## 10. Open decisions for a later implementation checkpoint

These do not block writing the plan, but must be resolved before the relevant milestone starts:

1. Pin the exact compatible versions of the two LSP npm packages for Bun.
2. Decide whether document synchronization is incremental or full after measuring implementation complexity.
3. Decide the configuration shape for `reettier` path and optional `--full` formatting.
4. Decide whether translation hover/definition should use `.reepolee/i18n` only or optionally consume a user-provided exported index path.
5. Decide whether VS Code migration happens in the same release or after a standalone-server release.
6. Decide whether the first non-VS Code client recipe is Neovim, Helix, or Zed.
