/**
 * Opens a link in the system browser (on a paired phone, the phone's own browser; `omp://` links route in the app).
 * A link that cannot open (the link to the computer dropped, a scheme the page refuses) says so in a toast instead
 * of leaving a click that does nothing and an unhandled rejection.
 */

import { toastError } from "../stores/toast";
import { translate } from "./i18n";

export function openExternal(url: string): void {
	const failed = (error: unknown) => void toastError({ title: translate("link.openFailed"), error });
	try {
		void Promise.resolve(window.omp.system.openExternal(url)).catch(failed);
	} catch (error) {
		failed(error);
	}
}
