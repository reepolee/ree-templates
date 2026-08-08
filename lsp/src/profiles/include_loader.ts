/**
 * Runtime import wrapper around the project's real include_resolver.ts.
 *
 * Tries to dynamically import the canonical resolver from the project root
 * at profile-detection time. Falls back to a shared local implementation.
 *
 * The real resolver has zero non-node imports (only `node:path` + `./types`),
 * so Bun's native TS loader can import it safely.
 */

import { existsSync } from "node:fs";
import { join, dirname, relative, resolve as resolve_path, extname } from "node:path";
import { posix } from "node:path";

import type { ResolvedTarget } from "./index";

const TEMPLATE_EXT = ".ree";

// ---------------------------------------------------------------------------
// Real resolver (loaded at runtime)
// ---------------------------------------------------------------------------

type ResolveIncludeFn = (
	current_name: string,
	include_name: string,
	views_dir: string,
	ext: string,
) => { kind: "template"; template_name: string } | { kind: "raw"; file_path: string };

/**
 * Try to import the project's real `resolve_include` function.
 * Returns null if the file doesn't exist or can't be imported.
 */
async function try_load_real_fn(project_root: string): Promise<ResolveIncludeFn | null> {
	const resolver_path = join(project_root, "lib", "template", "include_resolver.ts");
	if (!existsSync(resolver_path)) return null;

	try {
		const mod = await import(resolver_path);
		if (typeof mod.resolve_include === "function") return mod.resolve_include as ResolveIncludeFn;
	} catch { /* fall through */ }

	return null;
}

/** Convert real ResolveResult → ResolvedTarget, resolving template file_path. */
function from_real(result: ReturnType<ResolveIncludeFn>, views_dir: string): ResolvedTarget | undefined {
	if (result.kind === "template") {
		const file_path = join(views_dir, result.template_name + TEMPLATE_EXT);
		if (!existsSync(file_path)) return undefined;
		return { kind: "template", template_name: result.template_name, file_path };
	}
	if (result.kind === "raw" && result.file_path) {
		if (!existsSync(result.file_path)) return undefined;
		return { kind: "raw", file_path: result.file_path };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public: create a resolver for this project
// ---------------------------------------------------------------------------

export type IncludeResolver = (from_file: string, path_value: string, views_dir: string) => ResolvedTarget | undefined;

export async function create_include_resolver(project_root: string): Promise<IncludeResolver> {
	const real_fn = await try_load_real_fn(project_root);

	if (real_fn) {
		return (from_file, path_value, views_dir) => {
			const rel = relative(views_dir, from_file);
			const current_name = rel.endsWith(TEMPLATE_EXT) ? rel.slice(0, -TEMPLATE_EXT.length) : rel;
			try {
				return from_real(real_fn(current_name, path_value, views_dir, TEMPLATE_EXT), views_dir);
			} catch {
				return undefined;
			}
		};
	}

	// Fallback
	return (from_file, path_value, views_dir) => local_resolve(path_value, from_file, views_dir);
}

// ---------------------------------------------------------------------------
// Fallback local resolver (shared, used when real file is unavailable)
// ---------------------------------------------------------------------------

export function local_resolve(
	include_name: string,
	from_file: string,
	views_dir: string,
): ResolvedTarget | undefined {
	let name = include_name.trim();
	let is_alias = false;

	if (name.startsWith("$components/")) { name = name.replace("$components/", "components/"); is_alias = true; }
	else if (name.startsWith("$routes/"))   { name = name.replace("$routes/", "routes/"); is_alias = true; }
	else if (name.startsWith("$lib/"))      { name = name.replace("$lib/", "lib/"); is_alias = true; }

	if (!is_alias && name.startsWith("/")) {
		name = name.slice(1);
	} else if (!is_alias && (name.startsWith("./") || name.startsWith("../"))) {
		name = posix.join(dirname(from_file).replace(/\\/g, "/"), name);
	}

	const fext = extname(name);
	const base = is_alias ? dirname(views_dir) : views_dir;
	const target = fext ? name : name + TEMPLATE_EXT;
	const full = join(base, target);

	// Safety: no traversal
	const rel = relative(resolve_path(base), resolve_path(full));
	if (rel.startsWith("..")) return undefined;
	if (!existsSync(full)) return undefined;

	return fext && fext !== TEMPLATE_EXT
		? { kind: "raw", file_path: full }
		: { kind: "template", file_path: full, template_name: fext ? name.slice(0, -fext.length) : name };
}
