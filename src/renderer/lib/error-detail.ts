import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { translate } from "./i18n";

/**
 * Raw technical text of a caught failure, for a toast's or banner's quiet
 * secondary line — never its headline. Accepts a thrown value or a failed
 * result object (`{ error: string }`). Strips the wrappers that only add
 * noise: Electron's "Error invoking remote method '…': ", a leading
 * "Error: " that `String(error)` prepends, and main's `[code] ` marker.
 */
export function errorDetail(error: unknown): string {
	if (error == null) return "";
	let raw: string;
	if (error instanceof Error) raw = error.message;
	else if (typeof error === "string") raw = error;
	else if (typeof error === "object" && "error" in error) return errorDetail(error.error);
	else raw = String(error);
	return raw
		.replace(/^Error invoking remote method '[^']*':\s*/, "")
		.replace(/^(?:[A-Z]\w*)?Error:\s*/, "")
		.replace(/^\[[a-z_]+\]\s*/, "")
		.trim();
}

/**
 * The localized one-sentence headline for a failure: main's coded failures
 * (shared/ipc-error-codes) get their own sentence, anything else the generic
 * "try again". The raw text belongs in `errorDetail`.
 */
export function errorMessage(error: unknown): string {
	const code = ipcErrorCode(error);
	return code ? translate(`ipcError.${code}`) : translate("toast.failedRetry");
}
