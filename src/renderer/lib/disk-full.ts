/**
 * The disk is full (src/main/disk-full.ts): main pushes the files it could not save, to every window and to the paired
 * phone's page. One warning toast names them, stays until they are saved, is replaced when the list changes and goes
 * when it is empty. A window that mounts later asks main for the list once.
 */
import type { DiskFullState } from "../../shared/ipc-types";
import { toast, useToastStore } from "../stores/toast";
import { translate } from "./i18n";

/** Applies each state main sends; the one toast it shows is dismissed on `dispose`. */
export function createDiskFullToaster(): { apply(state: DiskFullState): void; dispose(): void } {
	let shown: { id: number; key: string } | null = null;
	const dismiss = (): void => {
		if (shown) useToastStore.getState().dismiss(shown.id);
		shown = null;
	};
	return {
		apply: state => {
			const key = state.files.join("\u0000");
			if (shown?.key === key) return;
			dismiss();
			if (state.files.length === 0) return;
			shown = {
				id: toast({
					variant: "warning",
					title: translate("diskFull.toastTitle"),
					message: translate("diskFull.toastBody", { files: state.files.join(", ") }),
					durationMs: Number.POSITIVE_INFINITY,
				}),
				key,
			};
		},
		dispose: dismiss,
	};
}

/** Wire main's pushes and the boot read once (App mount). Returns the unsubscribe. */
export function subscribeDiskFull(): () => void {
	const toaster = createDiskFullToaster();
	let pushed = false;
	let live = true;
	const unsubscribe = window.omp.events.onDiskFull(state => {
		pushed = true;
		toaster.apply(state);
	});
	// A push that arrived while the read was out is newer than its answer.
	window.omp.diskFull
		.get()
		.then(state => {
			if (live && !pushed) toaster.apply(state);
		})
		.catch(() => {});
	return () => {
		live = false;
		unsubscribe();
		toaster.dispose();
	};
}
