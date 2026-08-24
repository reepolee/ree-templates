/**
 * AST node types for the .ree template language.
 *
 * All nodes carry source offsets so features (diagnostics, completion, hover,
 * definition, folding) can derive LSP ranges without reparsing.
 *
 * The AST is lossless/tolerant - malformed input produces recovery nodes
 * rather than dropping content.
 */

// ---------------------------------------------------------------------------
// Source position
// ---------------------------------------------------------------------------

export interface SourceRange {
	/** Byte offset from start of document */
	start: number;
	/** Byte offset, exclusive */
	end: number;
}

// ---------------------------------------------------------------------------
// Token types (scanner-level)
// ---------------------------------------------------------------------------

export type TokenType =
	| "text"               // literal HTML text
	| "tag_open"           // <div ...>
	| "tag_close"          // </div>
	| "tag_self_close"     // <br />
	| "component_open"     // <comp-name ...>  (hyphenated)
	| "component_close"    // </comp-name>
	| "component_self_close" // <comp-name ... />
	| "block_open"         // {#if ...}, {#each ...}, {#with ...}
	| "block_else"         // {:else}
	| "block_close"        // {/if}, {/each}, {/with}
	| "output"             // {= expr } or {~ expr }
	| "translation"        // {_ key }, {- key }, {@ key }
	| "raw_js"             // {{ ... }}
	| "include"            // {#include("path") }
	| "layout"             // {#layout("path") }
	| "comment"            // <!-- ... -->
	| "script_body"        // <script>...</script> (opaque)
	| "style_body"         // <style>...</style> (opaque)
	| "pre_body"           // <pre>...</pre> (opaque)
	| "error"              // recovery placeholder
;

export interface Token {
	type: TokenType;
	range: SourceRange;
	/** For block_open: "if" | "each" | "with" | "switch" | "case" */
	block_type?: "if" | "each" | "with" | "switch" | "case";
	/** For output/translation: "=" | "~" | "_" | "-" | "@" */
	prefix?: string;
	/** Tag name for tag_open/tag_close/component_open/component_close */
	tag_name?: string;
	/** Attributes string (raw, between tag name and >) */
	attributes?: string;
	/** Whether the tag is self-closing (<br />) */
	self_closing?: boolean;
	/** Literal path value for include/layout */
	path_value?: string;
	/** Translation key for translation tokens */
	translation_key?: string;
	/** Expression content for output tokens */
	expression?: string;
	/** Recovery/nesting metadata */
	nest_level?: number;
	recovery?: boolean;
}

// ---------------------------------------------------------------------------
// AST node types (parser-level)
// ---------------------------------------------------------------------------

export type NodeType =
	| "document"
	| "text"
	| "element"             // HTML element
	| "component"           // ReeTag component (<comp-name>)
	| "block"               // if / each / with
	| "output"              // {= expr } / {~ expr }
	| "translation"         // {_ key } / {- key } / {@ key }
	| "raw_js"              // {{ ... }}
	| "include"             // {#include("path") }
	| "layout"              // {#layout("path") }
	| "comment"             // <!-- ... -->
	| "script"              // <script>...</script>
	| "style"               // <style>...</style>
	| "error"               // recovery / malformed node
;

export interface AstNode {
	type: NodeType;
	range: SourceRange;
	/** Children nodes (for document, element, component, block) */
	children?: AstNode[];
	/** For elements and components */
	tag_name?: string;
	/** For elements and components: raw attributes string */
	attributes?: string;
	/** For elements and components: whether self-closing */
	self_closing?: boolean;
	/** For block nodes: "if" | "each" | "with" | "switch" | "case" */
	block_type?: "if" | "each" | "with" | "switch" | "case";
	/** For block nodes: else branch (if present) */
	else_branch?: AstNode;
	/** For switch blocks: case branches with their conditions */
	case_branches?: { condition: string; children: AstNode[] }[];
	/** For output/translation: the prefix character */
	prefix?: string;
	/** For output: the JS expression */
	expression?: string;
	/** For translation: the dotted key */
	translation_key?: string;
	/** For include/layout: the literal path */
	path_value?: string;
	/** Recovery metadata */
	recovery?: boolean;
	error_message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple AST leaf node. */
export function leaf(type: NodeType, range: SourceRange, extra?: Partial<AstNode>): AstNode {
	return { type, range, ...extra };
}

/** Create a container AST node (document, element, block, etc.). */
export function container(type: NodeType, range: SourceRange, children: AstNode[], extra?: Partial<AstNode>): AstNode {
	return { type, range, children, ...extra };
}

/** Check if a node wraps children (is a container). */
export function has_children(node: AstNode): boolean {
	return node.type === "document" || node.type === "element" || node.type === "component" || node.type === "block";
}
