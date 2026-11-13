/**
 * The core's stores keep their change in memory and, when the disk is full, try the save again by themselves
 * (`crates/core/src/disk/saves.rs`). Each file that waits is told here as `store.saveFailed {file}` and `store.saved
 * {file}`, and joins the one disk-full notice (`disk-full.ts`). A core that ends takes its retries with it, so what it
 * reported is cleared.
 */
import { CORE_EXITED } from "./core/process";
import type { DiskFullWatch } from "./disk-full";

interface CoreEvents {
	on(event: string, listener: (data: unknown, bin: Uint8Array | null) => void): () => void;
}

function fileOf(data: unknown): string | null {
	const file = (data as { file?: unknown } | null)?.file;
	return typeof file === "string" && file !== "" ? file : null;
}

/** Starts listening; returns the stop. */
export function routeCoreSaves(source: CoreEvents, watch: DiskFullWatch): () => void {
	const waiting = new Set<string>();
	const stops = [
		source.on("store.saveFailed", data => {
			const file = fileOf(data);
			if (file === null) return;
			waiting.add(file);
			watch.report(file);
		}),
		source.on("store.saved", data => {
			const file = fileOf(data);
			if (file === null) return;
			waiting.delete(file);
			watch.clear(file);
		}),
		source.on(CORE_EXITED, () => {
			for (const file of waiting) watch.clear(file);
			waiting.clear();
		}),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
