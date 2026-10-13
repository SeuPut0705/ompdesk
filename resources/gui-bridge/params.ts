/** Narrowing for the GUI's untyped bridge params. */

/** The params object; anything else reads as empty. */
export function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `params[key]` as a non-empty string, or a `Missing <key>` error. */
export function requiredString(params: unknown, key: string): string {
	const value = asRecord(params)[key];
	if (typeof value !== "string" || !value) throw new Error(`Missing ${key}`);
	return value;
}
