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
		"project_family": "reeweb",
		"template_roots": ["src/public"],
		"component_roots": ["src/components"],
		"translation_provider": "route-json",
		"translation_roots": ["src/public"]
	}
}
```

Supported project families are `reepolee` and `reeweb`, both using the
`route-json` translation provider. The adapter is selected per document, so
multi-root editor workspaces can contain both project types. Legacy structure
detection remains available for projects without metadata.

When a project contains `config/env_var_descriptions.ts`, the server also
provides hover descriptions for documented environment-variable references in
JavaScript and TypeScript files. The file must export an `ENV_VAR_DESCRIPTIONS`
object. The path can be changed with `ree.envVarDescriptionsPath`.

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
- Translations are read from BCP 47 locale JSON files co-located with the
  templates. The language server never writes translation data.
- Tree-sitter and TypeScript language-service bridging are out of scope for v1.

## License

MIT - see [LICENSE](../../LICENSE) in the repository root.
