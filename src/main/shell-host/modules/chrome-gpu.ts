/**
 * The `chrome` module's gpu area (PROTOCOL.md §15.5; was `gpu-fallback.ts` and `launch-guard.ts`): the shell records
 * the launch, finds a crash loop, settles the GPU marker and turns hardware acceleration off itself before CEF starts,
 * names the GPU, follows its GPU process and relaunches into software rendering (`chrome_core::{gpu, launch}`). Node
 * keeps what it still reads: whether this launch is in safe mode (it pauses machine and memory setup), whether pages
 * composite in software (diagnostics), and that a quit was clean.
 */
import { chrome } from "./chrome";

type NoParams = Record<string, never>;

export interface GpuSpec {
	calls: {
		/** This launch's safe mode (the last three launches ended within 20 s) and whether it renders in software. */
		safeMode: { params: NoParams; result: { safeMode: boolean; software: boolean } };
		/** Whether pages composite in software, asked once the GPU process reported. */
		rendering: { params: NoParams; result: { software: boolean } };
	};
	posts: {
		/** `will-quit`: the launch quit cleanly, so it ends no crash loop. */
		stable: NoParams;
	};
	events: Record<never, never>;
	asks: Record<never, never>;
}

/**
 * Whether this launch started in safe mode: software rendering, no automatic relaunch, machine and memory setup
 * paused. The shell decided it before Node started; the answer never changes within a launch.
 */
export async function launchSafeMode(): Promise<boolean> {
	return (await chrome().call("safeMode", {})).safeMode;
}

let rendering: Promise<boolean> | undefined;

/**
 * Whether this launch composites in software: the crash marker, safe mode or `--disable-gpu` turned hardware
 * acceleration off, or Chromium itself fell back (no GPU, a blocklisted driver, a CI runner). Asked once per launch
 * (the shell logs it once). A shell that cannot answer reads as hardware.
 */
export function softwareCompositing(): Promise<boolean> {
	rendering ??= chrome()
		.call("rendering", {})
		.then(answer => answer.software)
		.catch((error: unknown) => {
			console.warn(`[gpu] rendering mode unknown: ${String(error)}`);
			return false;
		});
	return rendering;
}

/** This launch quits cleanly (`will-quit`): it ends no crash loop. A GPU relaunch's exit and a crash never get here. */
export function markLaunchStable(): void {
	chrome()
		.post("stable", {})
		.catch((error: unknown) => console.warn(`[gpu] stable not posted: ${String(error)}`));
}

/** A parity suite starts a fresh launch on its own shell. */
export function resetGpuClient(): void {
	rendering = undefined;
}
