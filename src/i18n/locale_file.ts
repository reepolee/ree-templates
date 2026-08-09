/**
 * BCP 47 locale JSON filename used by Reepolee and Reeweb.
 * Examples: "en-US.json", "sl-SI.json".
 */
export const LOCALE_FILE_RE = /^[a-z]{2}-[A-Z]{2}\.json$/i;

export function is_locale_file(file_name: string): boolean {
	return LOCALE_FILE_RE.test(file_name);
}

export function locale_file_name(locale: string): string {
	return `${locale}.json`;
}
