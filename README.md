Formatter for REE templates.

Ree templates are used by Reepolee for our Bun Apps.


** v2.0 is a breaking change as it ONLY expects BCP47 formatted locale like en-us.json vs DB translations or en.json. 

** v1.1 is a breaking change as it expects BCP47 formatted locale like en-us.json vs just language en.json. Use 1.0.x versions if you need old format.

## Formatters

The extension formats with **reettier**, an executable that reads source from
stdin. By default it keeps the line breaks you write and just fixes
indentation.

## Commands

- **ree: Format SQL (unwrap joins, remove backticks, clean)** (`ree.formatSqlFile`) - runs
  `reesql --stdin --unwrap-joins --remove-backticks --clean` on the current selection, or the whole `.sql` file when there is no selection.
- **ree: Format with reprint** (`ree.formatWithReprint`) - runs
  `reettier --full`, doing a full AST re-derivation of all line breaks instead
  of preserving the ones you wrote.
- **ree: Format with markup wrapping (file/selection)** (`ree.formatWithMarkup`) -
  prompts for a width and runs `reettier --wrap-markup --wrap-width <width>` on
  the current selection, or the whole `.ree` document when there is no selection.
- **ree: Check Formatters (path and version)** (`ree.checkFormatters`) - reports
  the installed version of `reettier`, looked up by its own name on PATH (so a
  path shim does not mask the real version). A missing CLI shows as
  `not installed`.
- **ree: Expand ReeTag (inline component here)** (`ree.expandReeTag`) - with the
  cursor on a `<tag-name>` ReeTag, replaces it with the body of
  `components/tag-name.ree`, substituting each attribute and the slot content
  in place of `props.attributes.*` / `props.children`. Use this to break a
  single call site off from the shared component when it needs more control
  than the component itself should offer.

## Settings

- `ree.reettierPath` - path to the reettier executable (empty = use PATH).
- `ree.formatOnSave` - formats `.js`, `.ts`, and `.css` files through `reettier`,
  and `.sql` files through plain `reesql`, when enabled.
- `ree.translation.defaultLocale` - locale used by translation inline
  decorations, hover, and definition selection (default: `en-US`).
- `ree.envVarDescriptionsPath` - project-relative TypeScript file exporting
  `ENV_VAR_DESCRIPTIONS` for environment-variable hover (default:
  `config/env_var_descriptions.ts`).
- `ree.server.command` - explicit language-server command.
- `ree.server.args` - arguments for the explicit server command.
- `ree.server.cwd` - working directory for the explicit server command.

The extension bundles its internal language server inside the VSIX and launches
it with Bun. Users do not need a sibling checkout, a global package, or a PATH
entry. The server settings are overrides for development and troubleshooting.
Translation hover reads every locale from the project's co-located locale JSON
files and refreshes when those files change. In JavaScript and
TypeScript files, the extension also shows descriptions for documented
`Bun.env.NAME`, `process.env.NAME`, bracket access, and `require_env("NAME")`
references. Descriptions come from the configured `ENV_VAR_DESCRIPTIONS` map.
The default descriptions file is watched and reloads when it changes.

Project behavior is selected from the project's `package.json` `ree` metadata.
This supports renamed and extended clones of both Reepolee and Ree Web templates.
