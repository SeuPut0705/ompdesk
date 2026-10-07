/**
 * Raw technical text of a caught failure, for a toast's or banner's quiet
 * secondary line — never its headline. Strips the wrappers that only add
 * noise: Electron's "Error invoking remote method '…': " and a leading
 * "Error: " that `String(error)` prepends.
 */
export function errorDetail(error: unknown): string {
	if (error == null) return "";
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
	return raw
		.replace(/^Error invoking remote method '[^']*':\s*/, "")
		.replace(/^(?:[A-Z]\w*)?Error:\s*/, "")
		.trim();
}
