/**
 * "omp updated to X": the one quiet toast after omp updated itself (main sends
 * it to a single window). A failure never toasts; it stays in Settings ›
 * Updates & about › This computer.
 */
import type { OmpUpdatedNotice } from "../../shared/omp-update";
import { type ToastInput, toast } from "../stores/toast";
import { translate } from "./i18n";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function ompUpdatedToast(notice: OmpUpdatedNotice, t: Translate): ToastInput {
	return { variant: "info", message: t("ompUpdate.updated", { version: notice.version }) };
}

/** Wire the main-process notice once (App mount). Returns unsubscribe. */
export function subscribeOmpUpdated(): () => void {
	return window.omp.ompUpdate.onUpdated(notice => toast(ompUpdatedToast(notice, translate)));
}
