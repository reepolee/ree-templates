/**
 * Document store that maintains open document state for the LSP server.
 *
 * Responsibilities:
 * - URI/path normalization
 * - Current text and version tracking
 * - Line-start lookup caching
 * - Position ↔ offset conversion
 * - Parsed-document caching (keyed by version)
 * - Invalidation after changes
 */

import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build_line_starts, offset_to_line } from "./positions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentEntry {
	document: TextDocument;
	line_starts: number[];
	/** Cached parse result, if any (keyed by version) */
	parsed: unknown | undefined;
	parsed_version: number;
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file:// URI to a consistent string, or return the input as-is
 * if it's already a path.
 */
export function normalize_uri(uri: string): string {
	if (uri.startsWith("file://")) {
		try {
			// On Windows, fileURLToPath produces a drive-letter path.
			// Normalize to forward slashes for internal consistency.
			return fileURLToPath(uri).replace(/\\/g, "/");
		} catch {
			return uri;
		}
	}
	return uri.replace(/\\/g, "/");
}

/**
 * Convert a normalized file path back to a file:// URI.
 */
export function path_to_uri(file_path: string): string {
	return pathToFileURL(file_path).href;
}

// ---------------------------------------------------------------------------
// Document Store
// ---------------------------------------------------------------------------

export class DocumentStore {
	private documents = new Map<string, DocumentEntry>();

	/**
	 * Open a document with the given text and language ID.
	 */
	open(uri: string, languageId: string, version: number, text: string): DocumentEntry {
		const key = normalize_uri(uri);
		const document = TextDocument.create(uri, languageId, version, text);
		const entry: DocumentEntry = {
			document,
			line_starts: build_line_starts(text),
			parsed: undefined,
			parsed_version: -1,
		};
		this.documents.set(key, entry);
		return entry;
	}

	/**
	 * Update a document's text incrementally or fully.
	 */
	update(uri: string, version: number, text: string): DocumentEntry {
		const key = normalize_uri(uri);
		const existing = this.documents.get(key);
		if (!existing) {
			// Document not previously opened; create it now
			return this.open(uri, "ree", version, text);
		}

		const document = TextDocument.create(uri, existing.document.languageId, version, text);
		const entry: DocumentEntry = {
			document,
			line_starts: build_line_starts(text),
			parsed: undefined,
			parsed_version: -1,
		};
		this.documents.set(key, entry);
		return entry;
	}

	/**
	 * Close and remove a document.
	 */
	close(uri: string): void {
		const key = normalize_uri(uri);
		this.documents.delete(key);
	}

	/**
	 * Get a document entry by URI.
	 */
	get(uri: string): DocumentEntry | undefined {
		const key = normalize_uri(uri);
		return this.documents.get(key);
	}

	/**
	 * Convert a byte offset to line number for the given document.
	 */
	offset_to_line(uri: string, offset: number): number {
		const entry = this.get(uri);
		if (!entry) return 0;
		return offset_to_line(entry.line_starts, offset);
	}

	/**
	 * Check if a document is currently open.
	 */
	has(uri: string): boolean {
		return this.documents.has(normalize_uri(uri));
	}

	/**
	 * Iterate over all open documents.
	 */
	[Symbol.iterator](): IterableIterator<[string, DocumentEntry]> {
		return this.documents[Symbol.iterator]();
	}
}
