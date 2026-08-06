import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves a ReeTag's `tag-name` to its component source file under the
 * project's `components/` folder (the `$components/` prefix documented in
 * REE_TEMPLATES.md's Path Resolution table).
 *
 * Mirrors the include-path convention: `<product-card>` -> `components/product-card.ree`.
 */
export function resolve_component_path(project_root: string, tag_name: string): string | undefined {
	const candidate = path.join(project_root, 'components', `${tag_name}.ree`);
	return fs.existsSync(candidate) ? candidate : undefined;
}

export function read_component_source(component_path: string): string {
	return fs.readFileSync(component_path, 'utf-8');
}
