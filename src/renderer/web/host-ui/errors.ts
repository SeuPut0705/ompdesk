import { ipcErrorCode } from "../../../shared/ipc-error-codes";
import { errorMessage } from "../../lib/error-detail";
import { translate } from "../../lib/i18n";

/**
 * The sentence a failed call to the computer shows in a sheet. A device without `desktop-control` gets told
 * where to switch it on (the host answers `web_forbidden`); every other failure is its localized code text.
 */
export function hostActionError(error: unknown): string {
	if (ipcErrorCode(error) === "web_forbidden") return translate("hostUi.computerOff");
	return errorMessage(error);
}

/** The reason an answer carried (`{ok: false, error}`), or the localized generic one. */
export function failureText(error: string | undefined): string {
	return translate("hostUi.failed", { error: error ?? "" }).trim();
}
