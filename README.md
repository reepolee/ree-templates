Formatter for REE templates.

Ree templates are used by Reepolee for our Bun Apps.

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

## Settings

- `ree.reettierPath` - path to the reettier executable (empty = use PATH).
