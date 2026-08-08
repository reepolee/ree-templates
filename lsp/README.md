# ree-lsp

Internal language server for the `ree-templates` VS Code extension.

**Status:** Standalone server with structural parsing, diagnostics, completion,
hover, definition, symbols, folding, and formatter integration.

## Requirements

- [Bun](https://bun.com/) 1.4.0 or later

## Project adapters

The server's language core is project-neutral. A project selects a bundled
adapter through the `ree` object in its `package.json`:

```json
{
	"ree": {
		"project_family": "ree-web",
		"template_roots": ["src/public"],
		"component_roots": ["src/components"],
		"translation_provider": "route-json",
		"translation_root": "src/public"
	}
}
```

Supported project families are `reepolee` with the `db-export` translation
provider and `ree-web` with the `route-json` provider. The adapter is selected
per document, so multi-root editor workspaces can contain both project types.
Legacy structure detection remains available for projects without metadata.

The extension bundles this server into its VSIX. It remains an LSP over stdio
inside that product, but is not separately installed or distributed.

## Development

```bash
bun install        # Install dependencies
bun run typecheck  # Type-check the project
bun test           # Run tests
```

## Project structure

```
ree-templates/lsp/
  src/
    server.ts                  # Main LSP server (stdio transport)
    documents/
      document_store.ts        # Open-document manager
      positions.ts             # LSP Position ↔ offset conversion
    parser/                    # Tolerant scanner and structural parser
    profiles/                  # Project detection and path resolution
    features/                  # Completion, hover, definition, and more
  test/
    lsp_protocol.test.ts       # Protocol smoke tests
    fixtures/                   # Test fixtures (future)
```

## Current limitations

- Embedded JavaScript/TypeScript intelligence is explicitly deferred to a
  future milestone.
- DB-backed translations are read from `.reepolee/i18n/*.json`, the read-only
  editor export. The language server never writes translation data.
- Tree-sitter and TypeScript language-service bridging are out of scope for v1.

## License

MIT - see [LICENSE](../../LICENSE) in the repository root.
