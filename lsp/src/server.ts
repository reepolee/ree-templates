#!/usr/bin/env bun

/**
 * Stdio LSP server for .ree templates.
 *
 * Implements the standard LSP lifecycle with diagnostics, completion,
 * hover, definition, document symbols, folding ranges, and formatting.
 *
 * Advertised capabilities:
 * - textDocumentSync (full)
 * - diagnostics (via publishDiagnostics)
 * - completion (with trigger characters)
 * - hover
 * - definition
 * - documentSymbol
 * - documentFormatting
 */

import {
	createConnection,
	ProposedFeatures,
	TextDocumentSyncKind,
	type InitializeParams,
	type InitializeResult,
} from "vscode-languageserver/node";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";

import { DocumentStore } from "./documents/document_store";
import { compute_diagnostics } from "./features/diagnostics";
import {
	compute_completions,
	invalidate_translation_cache as invalidate_completion_translation_cache,
} from "./features/completion";
import {
	compute_hover,
	invalidate_translation_cache as invalidate_hover_translation_cache,
} from "./features/hover";
import { find_definition } from "./features/definition";
import { compute_symbols, compute_folding_ranges } from "./features/symbols";
import { format_document } from "./features/formatting";
import { detect_profile, type ReeProjectProfile } from "./profiles/index";
import { invalidate_component_index } from "./profiles/reepolee";
import { DEFAULT_ENV_VAR_DESCRIPTIONS_PATH } from "./profiles/env_var_descriptions";

// ---------------------------------------------------------------------------
// Create connection
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const documents = new DocumentStore();

/** Per-document project adapters. Supports multi-root workspaces. */
const profile_cache = new Map<string, ReeProjectProfile | null>();

// ---------------------------------------------------------------------------
// Initialize handler
// ---------------------------------------------------------------------------

/**
 * Locale used to pick which file go-to-definition opens when a key exists in
 * several locales. Supplied by the client and refreshed on settings changes.
 */
let preferred_locale: string | undefined;
let env_var_descriptions_path = DEFAULT_ENV_VAR_DESCRIPTIONS_PATH;

function read_preferred_locale(settings: unknown): string | undefined {
	if (settings === null || typeof settings !== "object") return undefined;
	const ree_settings = (settings as Record<string, unknown>).ree;
	if (ree_settings === null || typeof ree_settings !== "object") return undefined;
	const translation = (ree_settings as Record<string, unknown>).translation;
	if (translation === null || typeof translation !== "object") return undefined;
	const locale = (translation as Record<string, unknown>).defaultLocale;
	return typeof locale === "string" && locale.length > 0 ? locale : undefined;
}

function read_env_var_descriptions_path(settings: unknown): string {
	if (settings === null || typeof settings !== "object") return DEFAULT_ENV_VAR_DESCRIPTIONS_PATH;
	const ree_settings = (settings as Record<string, unknown>).ree;
	if (ree_settings === null || typeof ree_settings !== "object") return DEFAULT_ENV_VAR_DESCRIPTIONS_PATH;
	const path_value = (ree_settings as Record<string, unknown>).envVarDescriptionsPath;
	return typeof path_value === "string" ? path_value : DEFAULT_ENV_VAR_DESCRIPTIONS_PATH;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
	profile_cache.clear();
	preferred_locale = read_preferred_locale(params.initializationOptions);
	env_var_descriptions_path = read_env_var_descriptions_path(params.initializationOptions);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			completionProvider: {
				triggerCharacters: ["{", ".", " "],
				resolveProvider: false,
			},
			hoverProvider: true,
			definitionProvider: true,
			documentSymbolProvider: true,
			documentFormattingProvider: true,
		},
		serverInfo: {
			name: "ree-lsp",
			version: "0.1.0",
		},
	};
});

connection.onInitialized(() => {
	// Ready to accept document changes and requests.
});

connection.onDidChangeConfiguration((params) => {
	const updated = read_preferred_locale(params.settings);
	const updated_env_var_descriptions_path = read_env_var_descriptions_path(params.settings);
	if (updated === preferred_locale && updated_env_var_descriptions_path === env_var_descriptions_path) return;
	preferred_locale = updated;
	env_var_descriptions_path = updated_env_var_descriptions_path;
	profile_cache.clear();
});

// ---------------------------------------------------------------------------
// Document synchronization + diagnostics
// ---------------------------------------------------------------------------

connection.onDidOpenTextDocument((params) => {
	documents.open(
		params.textDocument.uri,
		params.textDocument.languageId,
		params.textDocument.version,
		params.textDocument.text,
	);

	const diagnostics = compute_diagnostics(params.textDocument.text);
	connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics });
});

connection.onDidChangeTextDocument((params) => {
	const change = params.contentChanges[0];
	if (change) {
		documents.update(
			params.textDocument.uri,
			params.textDocument.version,
			change.text,
		);

		const diagnostics = compute_diagnostics(change.text);
		connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics });
	}
});

connection.onDidCloseTextDocument((params) => {
	documents.close(params.textDocument.uri);
	connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(() => {
	invalidate_completion_translation_cache();
	invalidate_hover_translation_cache();
	invalidate_component_index();
	profile_cache.clear();
});

// ---------------------------------------------------------------------------
// Completion handler
// ---------------------------------------------------------------------------

connection.onCompletion(async (params) => {
	try {
		const entry = documents.get(params.textDocument.uri);
		const text = entry?.document.getText() ?? "";
		const project_profile = await profile_for_document(params.textDocument.uri);
		return compute_completions(text, params.position, project_profile, params.textDocument.uri);
	} catch (err: any) {
		console.error(`ree-lsp completion error: ${err.message ?? err}`);
		return [];
	}
});

// ---------------------------------------------------------------------------
// Hover handler
// ---------------------------------------------------------------------------

connection.onHover(async (params) => {
	try {
		const entry = documents.get(params.textDocument.uri);
		const text = entry?.document.getText() ?? "";
		const project_profile = await profile_for_document(params.textDocument.uri);
		return compute_hover(text, params.position, project_profile, params.textDocument.uri);
	} catch (err: any) {
		console.error(`ree-lsp hover error: ${err.message ?? err}`);
		return null;
	}
});

// ---------------------------------------------------------------------------
// Definition handler
// ---------------------------------------------------------------------------

connection.onDefinition(async (params) => {
	try {
		const entry = documents.get(params.textDocument.uri);
		const text = entry?.document.getText() ?? "";
		const project_profile = await profile_for_document(params.textDocument.uri);
		return find_definition(text, params.position, params.textDocument.uri, project_profile?.project_root, project_profile, preferred_locale);
	} catch (err: any) {
		console.error(`ree-lsp definition error: ${err.message ?? err}`);
		return null;
	}
});

// ---------------------------------------------------------------------------
// Document Symbols handler
// ---------------------------------------------------------------------------

connection.onDocumentSymbol((params) => {
	const entry = documents.get(params.textDocument.uri);
	const text = entry?.document.getText() ?? "";
	return compute_symbols(text);
});

// ---------------------------------------------------------------------------
// Folding Range handler
// ---------------------------------------------------------------------------

connection.onFoldingRanges((params) => {
	const entry = documents.get(params.textDocument.uri);
	const text = entry?.document.getText() ?? "";
	return compute_folding_ranges(text);
});

// ---------------------------------------------------------------------------
// Document Formatting handler
// ---------------------------------------------------------------------------

connection.onDocumentFormatting(async (params) => {
	const entry = documents.get(params.textDocument.uri);
	if (!entry) return [];

	const text = entry.document.getText();
	const project_profile = await profile_for_document(params.textDocument.uri);
	const cwd = project_profile?.project_root ?? process.cwd();

	const result = await format_document(text, { cwd });

	if (result.error) {
		// Log to stderr (LSP log stream)
		console.error(`ree-lsp formatting error: ${result.error}`);
	}

	return result.edit ? [result.edit] : [];
});

// ---------------------------------------------------------------------------
// Custom: get translations for inline decorations
// ---------------------------------------------------------------------------

connection.onRequest("ree/getTranslations", async (params: { textDocument: { uri: string } }) => {
	try {
		const document_file = fileURLToPath(params.textDocument.uri);
		const project_profile = await profile_for_document(params.textDocument.uri);
		if (!project_profile?.translation_definition_files) return null;

		const locale_files = project_profile.translation_definition_files(document_file);
		const result: Record<string, Record<string, string>> = {};

		for (const full_path of locale_files) {
			const locale = basename(full_path, ".json");
			if (result[locale]) continue; // first file wins (most specific)

			const index = project_profile.load_translation_index?.(full_path, document_file);
			if (index && index.size > 0) {
				result[locale] = Object.fromEntries(index);
			}
		}

		return result;
	} catch (err: any) {
		console.error(`ree-lsp getTranslations error: ${err.message ?? err}`);
		return null;
	}
});

connection.onRequest("ree/getEnvVarDescription", async (params: { textDocument: { uri: string }; name: string }) => {
	if (!/^[A-Z][A-Z0-9_]*$/.test(params.name)) return null;

	try {
		const project_profile = await profile_for_document(params.textDocument.uri);
		return project_profile?.env_var_descriptions.get(params.name) ?? null;
	} catch (err: any) {
		console.error(`ree-lsp getEnvVarDescription error: ${err.message ?? err}`);
		return null;
	}
});

// ---------------------------------------------------------------------------
// Shutdown / Exit handlers
// ---------------------------------------------------------------------------

connection.onShutdown(() => {
	// Cleanup resources if needed
});

async function profile_for_document(document_uri: string): Promise<ReeProjectProfile | null> {
	try {
		const document_file = fileURLToPath(document_uri);
		const document_dir = dirname(document_file);
		if (profile_cache.has(document_dir)) {
			return profile_cache.get(document_dir) ?? null;
		}

		const project_profile = await detect_profile(document_dir, env_var_descriptions_path);
		profile_cache.set(document_dir, project_profile);
		return project_profile;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

connection.listen();
