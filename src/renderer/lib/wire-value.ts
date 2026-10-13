/**
 * Narrowing helpers for untyped wire values (tool `details`, bridge payloads).
 * Each returns the value only when it has the expected shape, so renderers can
 * read optional fields without casts.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A string with at least one character; optional string fields often arrive empty. */
export function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
