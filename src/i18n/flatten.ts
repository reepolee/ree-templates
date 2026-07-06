/**
 * Recursively flattens a nested JSON object into dot-notation key-value pairs.
 *
 * ```ts
 * flatten({ hero: { title: "Welcome" } })
 * // => { "hero.title": "Welcome" }
 * ```
 */
export function flatten(
	obj: Record<string, unknown>,
	prefix = ''
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;

		if (typeof value === 'string') {
			result[fullKey] = value;
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			result[fullKey] = String(value);
		} else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			// Recurse into nested objects
			Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
		} else if (Array.isArray(value)) {
			// Stringify arrays
			result[fullKey] = JSON.stringify(value);
		}
		// Skip null/undefined
	}

	return result;
}
