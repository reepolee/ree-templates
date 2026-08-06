Formatter for REE templates.

Ree templates are used by Reepolee for our Bun Apps.

** v1.1 is a breaking change as it expects BCP47 formatted locale like en-us.json vs just language en.json. Use 1.0.x versions if you need old format.

## Formatters

The extension formats with **reettier**, an executable that reads source from
stdin. By default it keeps the line breaks you write and just fixes
indentation.

## Commands

- **ree: Format with reprint** (`ree.formatWithReprint`) - runs
  `reettier --full`, doing a full AST re-derivation of all line breaks instead
  of preserving the ones you wrote.
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
