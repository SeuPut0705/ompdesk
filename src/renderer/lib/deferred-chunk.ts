/**
 * A chunk the first screen leaves out but the person's next touch or key may need (the dialogs only they open, the
 * first-run setup): loaded at once or in the first idle moment, and at the first `pointerdown`/`keydown` if that comes
 * sooner, since each of those opens from one. A load that fails is tried again at the next touch or key, never in a
 * loop and never left for good: a phone that dropped off the network for a moment got its dialogs back on the next
 * tap. A failure that is not a chunk load (`isChunkLoadError`) is logged.
 */
import { isChunkLoadError } from "./chunk-load";
import { whenIdle } from "./idle";

/** The longest the first idle moment may take to come. */
const IDLE_TIMEOUT_MS = 2000;
const TRIGGERS = ["pointerdown", "keydown"] as const;

export interface DeferredChunk<T> {
	load: () => Promise<T>;
	onLoaded: (value: T) => void;
	/** After a failed load, before the next touch or key tries again. */
	onFailed?: () => void;
	/** `now`: start loading at once; `idle`: in the first idle moment. */
	start: "now" | "idle";
}

export interface DeferredChunkScheduling {
	/** Where a touch or key starts the load (capture phase, before the control it reaches). */
	target: Pick<Window, "addEventListener" | "removeEventListener">;
	/** Run `callback` in an idle moment; returns the cancel. */
	idle: (callback: () => void) => () => void;
}

/** Load `chunk` as described above; returns the cancel (an unmount), after which nothing is delivered. */
export function loadDeferredChunk<T>(
	chunk: DeferredChunk<T>,
	scheduling: DeferredChunkScheduling = { target: window, idle: callback => whenIdle(callback, IDLE_TIMEOUT_MS) },
): () => void {
	let cancelled = false;
	let loading = false;
	let cancelIdle = () => {};
	const disarm = () => {
		for (const type of TRIGGERS) scheduling.target.removeEventListener(type, trigger, true);
	};
	const arm = () => {
		for (const type of TRIGGERS) scheduling.target.addEventListener(type, trigger, true);
	};
	function trigger(): void {
		if (cancelled || loading) return;
		loading = true;
		disarm();
		cancelIdle();
		chunk.load().then(
			value => {
				if (!cancelled) chunk.onLoaded(value);
			},
			(error: unknown) => {
				loading = false;
				if (!isChunkLoadError(error)) console.error("[deferred-chunk] load failed", error);
				if (cancelled) return;
				chunk.onFailed?.();
				arm();
			},
		);
	}
	if (chunk.start === "now") {
		trigger();
	} else {
		arm();
		cancelIdle = scheduling.idle(trigger);
	}
	return () => {
		cancelled = true;
		disarm();
		cancelIdle();
	};
}
