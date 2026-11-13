/**
 * The person's one notice that the disk is full ("OMPdesk could not save <what>; it will retry"): shown when the first
 * file cannot be saved, never again while any file still waits, and closed when the last one is on disk. The writers
 * retry by themselves (`atomic-file.ts`); this only tells. Electron-free: index.ts passes the OS notification.
 */
import { type DiskFullState, IPC_EVENTS } from "../shared/ipc-types";
import type { DiskFullWatch } from "./disk-full";

export interface DiskFullNoticeDeps {
	/** Shows the notice; `close` takes it back once every file is saved. */
	show(notice: { title: string; body: string }): { close(): void };
	/** The notice's words, in the UI language, for the files that wait. */
	text(names: readonly string[]): { title: string; body: string };
}

/** Starts telling; returns the stop. */
export function bindDiskFullNotice(watch: DiskFullWatch, deps: DiskFullNoticeDeps): () => void {
	let shown: { close(): void } | undefined;
	const stop = watch.onChange(names => {
		if (names.length === 0) {
			shown?.close();
			shown = undefined;
			return;
		}
		shown ??= deps.show(deps.text(names));
	});
	return () => {
		stop();
		shown?.close();
		shown = undefined;
	};
}

const NAMES_SHOWN = 3;

/** The files that wait as one phrase: the first few by name, then how many more. */
export function describeFiles(names: readonly string[]): string {
	const first = names.slice(0, NAMES_SHOWN).join(", ");
	return names.length > NAMES_SHOWN ? `${first} +${names.length - NAMES_SHOWN}` : first;
}

/** A window or a paired phone's page. */
export interface DiskFullTarget {
	isDestroyed(): boolean;
	webContents: { send(channel: string, data: unknown): void };
}

/** Tells every window and page the files that wait for space whenever they change (an empty list: all saved). */
export function bindDiskFullPush(watch: DiskFullWatch, targets: () => Iterable<DiskFullTarget>): () => void {
	return watch.onChange(files => {
		const state: DiskFullState = { files: [...files] };
		for (const target of targets()) if (!target.isDestroyed()) target.webContents.send(IPC_EVENTS.DISK_FULL, state);
	});
}
