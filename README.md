Formatter for REE templates.

Ree templates are used by Reepolee for our Bun Apps.

## Formatters

The extension can format with either of two executables. Choose one with the
`ree.formatter` setting:

- **reefmt** (default) - a standard AST reprinter. It re-derives all line
  breaks from the syntax tree. Install from https://github.com/reepolee/reefmt.
- **reettier** - an indenter only. It keeps the line breaks you write and just
  fixes indentation.

Both are executables that read source from stdin.

## Commands

- **ree: Check Formatters (path and version)** (`ree.checkFormatters`) - reports
  the installed version of both `reefmt` and `reettier`, looking each one up by
  its own name on PATH (so a path shim does not mask the real version). The one
  selected by `ree.formatter` is marked `(active)`; a missing CLI shows as
  `not installed`.

## Settings

- `ree.formatter` - which formatter to use (`reefmt` or `reettier`).
- `ree.reefmtPath` - path to the reefmt executable (empty = use PATH).
- `ree.reettierPath` - path to the reettier executable (empty = use PATH).
