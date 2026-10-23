/**
 * Fills a translated string's `{name}` placeholders, for the renderer's `translate` and main's `mainT` alike.
 *
 * One pass: a value is never re-scanned (a path holding "{name}" stays literal), a placeholder repeated in a string is
 * filled everywhere, and "$&"-style patterns in a value are not special. `{plural}` is "s" unless `count` is 1, and
 * `{<name>Plural}` the same for any other number (`{tools} tool call{toolsPlural}`), when the caller does not say
 * otherwise ("1 session", "2 sessions"). A number passed already formatted ("1,204") is read back; "1+" is more than
 * one. A placeholder without a value stays as written.
 */
export function fillText(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	const filled: Record<string, string | number> = { ...params };
	for (const [name, value] of Object.entries(params)) {
		const slot = name === "count" ? "plural" : `${name}Plural`;
		if (Object.hasOwn(params, slot)) continue;
		const text = String(value).trim();
		if (!/^\d/.test(text)) continue;
		filled[slot] = Number(text.replace(/[,\s\u00a0\u202f']/g, "")) === 1 ? "" : "s";
	}
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(filled, name) ? String(filled[name]) : match,
	);
}
