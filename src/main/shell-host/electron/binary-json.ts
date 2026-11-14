/**
 * Bytes inside JSON: the page and the shell write a `Uint8Array` as `{"$bin": "<base64>"}` anywhere in the arguments
 * of `ipc.*` and `wc.send` and in an invoke's value (PROTOCOL.md §12). Electron's structured clone carried them as
 * they were, so main's handlers see (and return) real bytes.
 */
function isBin(value: object): value is { $bin: string } {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$bin" && typeof (value as { $bin: unknown }).$bin === "string";
}

/** `{$bin}` → `Buffer`, at any depth. */
export function decodeBin(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeBin);
	if (typeof value !== "object" || value === null) return value;
	if (isBin(value)) return Buffer.from(value.$bin, "base64");
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decodeBin(inner)]));
}

/** `Buffer`, `Uint8Array` and `ArrayBuffer` → `{$bin}`, at any depth. */
export function encodeBin(value: unknown): unknown {
	if (value instanceof ArrayBuffer) return { $bin: Buffer.from(value).toString("base64") };
	if (ArrayBuffer.isView(value))
		return { $bin: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
	if (Array.isArray(value)) return value.map(encodeBin);
	if (typeof value !== "object" || value === null) return value;
	if (value instanceof Date) return value;
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encodeBin(inner)]));
}
