/**
 * The launch guard and the GPU fallback against the real shell (PROTOCOL.md §15.3; was `launch-guard.test.ts`,
 * `gpu-fallback.test.ts` and `gpu-fallback-loop.test.ts`): each case is a launch of the built shell over a profile
 * folder seeded with the files an earlier launch left (`prepare`), and reads what the launch wrote there and the
 * runtime-log lines it produced (the shell's own log keeps each as `chrome.runtime_log`: Node's file is written later).
 * The shell's test seam `OMP_GUI_TEST_GPU_GONE=1` (`chrome.testGpuGone`) stands for a GPU process that ended, since a
 * real crash cannot be made on demand; the process watcher itself is the shell's and is not under test here. The
 * rules are `chrome_core::{gpu, launch}`'s Rust tests and their captured replay (which also cover the adapter
 * identity cases, as the macOS shell lists no adapters).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pointChromeAt } from "./chrome";
import { launchSafeMode, markLaunchStable, resetGpuClient, softwareCompositing } from "./chrome-gpu";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const exe = testShellExecutable();

const DAY = 24 * 60 * 60_000;
const SPAN = 120_000;
const crash = { reason: "crashed", exitCode: -1073741819 };

interface Seeds {
	marker?: string;
	history?: string;
}

interface Line {
	source: string;
	message: string;
	details?: Record<string, unknown>;
}

interface Left {
	marker: Record<string, unknown> | null;
	history: Array<Record<string, unknown>> | null;
	lines: Line[];
}

interface Launch {
	args?: string[];
	env?: Record<string, string>;
	seeds?: Seeds;
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function lines(shell: TestShell): Line[] {
	try {
		return readFileSync(path.join(shell.userData, "shell-webview", "shell.log.jsonl"), "utf8")
			.split("\n")
			.flatMap(text => {
				try {
					const entry = JSON.parse(text) as Line & { event?: string };
					return entry.event === "chrome.runtime_log" ? [entry] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function messages(found: Line[]): string {
	return found.map(line => line.message).join("\n");
}

function leftBy(shell: TestShell): Left {
	return {
		marker: readJson(path.join(shell.userData, "gpu-fallback.json")),
		history: readJson(path.join(shell.userData, "launch-history.json")),
		lines: lines(shell),
	};
}

/** One launch of the shell: the seeds, then `body` with the live shell; what the launch left is read before it closes. */
async function launch(options: Launch, body: (shell: TestShell) => Promise<void> = async () => {}): Promise<Left> {
	const shell = await startTestShell(exe as string, {
		args: options.args,
		env: {
			// A test launch (OMP_GUI_HEADLESS) never relaunches, and the guard runs in a packaged launch only.
			OMP_GUI_HEADLESS: "",
			OMP_GUI_LAUNCH_GUARD: "1",
			OMP_GUI_TEST_GPU_GONE: "1",
			...options.env,
		},
		prepare: userData => {
			const { marker, history } = options.seeds ?? {};
			if (marker !== undefined) writeFileSync(path.join(userData, "gpu-fallback.json"), marker);
			if (history !== undefined) writeFileSync(path.join(userData, "launch-history.json"), history);
		},
	});
	pointChromeAt(() => shell.client);
	resetGpuClient();
	try {
		await body(shell);
		return leftBy(shell);
	} finally {
		await shell.close().catch(() => {});
	}
}

/** The launch ends (the relaunch's `app.exit(0)`): its exit code. */
function exitOf(shell: TestShell): Promise<number | null> {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	if (shell.process.exitCode !== null) resolve(shell.process.exitCode);
	else shell.process.once("exit", code => resolve(code));
	return promise;
}

async function gone(
	shell: TestShell,
	details: { reason: string; exitCode: number; upMs?: number } = crash,
): Promise<void> {
	await shell.client.event("chrome.testGpuGone", details);
}

function marker(fields: Record<string, unknown>, at = Date.now()): string {
	return JSON.stringify({ at: new Date(at).toISOString(), ...fields });
}

function unstable(count: number): string {
	const now = Date.now();
	return JSON.stringify(Array.from({ length: count }, (_, i) => ({ at: now - (count - i) * 1000 })));
}

describe.skipIf(!exe)("crash-loop guard", () => {
	it(
		"records every launch, and a first launch is not in safe mode",
		async () => {
			const left = await launch({}, async () => {
				expect(await launchSafeMode()).toBe(false);
			});
			expect(left.history).toHaveLength(1);
			expect(left.history?.[0]).not.toHaveProperty("safeMode");
		},
		SPAN,
	);

	it(
		"starts in safe mode after three launches in a row ended before they became stable",
		async () => {
			const left = await launch({ seeds: { history: unstable(3) } }, async shell => {
				expect(await launchSafeMode()).toBe(true);
				expect(await shell.client.call("chrome.safeMode", {})).toEqual({ safeMode: true, software: true });
			});
			expect(left.history).toHaveLength(4);
			expect(left.history?.at(-1)).toMatchObject({ safeMode: true });
			expect(left.lines).toContainEqual(
				expect.objectContaining({
					source: "launch-guard",
					message: expect.stringContaining("Safe mode: the last 3 launches ended within 20 s of starting"),
				}),
			);
			expect(messages(left.lines)).toContain("Hardware acceleration disabled (safe mode)");
		},
		SPAN,
	);

	it(
		"a stable or cleanly quit launch among them is no loop",
		async () => {
			const now = Date.now();
			const history = JSON.stringify([{ at: now - 3000 }, { at: now - 2000, stable: true }, { at: now - 1000 }]);
			const left = await launch({ seeds: { history } }, async () => {
				expect(await launchSafeMode()).toBe(false);
			});
			expect(left.history).toHaveLength(4);
		},
		SPAN,
	);

	it(
		"launches that ended long ago are no loop",
		async () => {
			const old = Date.now() - 30 * 60_000;
			const history = JSON.stringify([{ at: old }, { at: old + 1000 }, { at: old + 2000 }]);
			await launch({ seeds: { history } }, async () => {
				expect(await launchSafeMode()).toBe(false);
			});
		},
		SPAN,
	);

	it(
		"an unreadable history never blocks a start and is written again",
		async () => {
			const left = await launch({ seeds: { history: "{not json" } }, async () => {
				expect(await launchSafeMode()).toBe(false);
			});
			expect(left.history).toHaveLength(1);
		},
		SPAN,
	);

	it(
		"a safe-mode launch that quits cleanly ends safe mode for the next one",
		async () => {
			const first = await launch({ seeds: { history: unstable(3) } }, async shell => {
				expect(await launchSafeMode()).toBe(true);
				markLaunchStable();
				await vi.waitFor(() => {
					const history = readJson<Array<{ stable?: boolean }>>(path.join(shell.userData, "launch-history.json"));
					expect(history?.at(-1)?.stable).toBe(true);
				});
			});
			await launch({ seeds: { history: JSON.stringify(first.history) } }, async () => {
				expect(await launchSafeMode()).toBe(false);
			});
		},
		SPAN * 2,
	);

	it(
		"a launch that is no packaged run records nothing without the forcing flag",
		async () => {
			const shell = await startTestShell(exe as string, {
				env: { OMP_GUI_HEADLESS: "", OMP_GUI_LAUNCH_GUARD: "" },
			});
			try {
				expect(existsSync(path.join(shell.userData, "launch-history.json"))).toBe(false);
			} finally {
				await shell.close();
			}
		},
		SPAN,
	);
});

describe.skipIf(!exe)("GPU crash relaunch", () => {
	it(
		"never relaunches a launch that already renders in software (the marker's own launch)",
		async () => {
			// Windows still runs a GPU process for SwiftShader/WARP with hardware acceleration off; when that one dies too,
			// a relaunch from here starts the same software launch again: on, off, on, off.
			const left = await launch(
				{ seeds: { marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }) } },
				async shell => {
					expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: true });
					await gone(shell);
					await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch"));
					expect(shell.process.exitCode).toBeNull();
				},
			);
			expect(messages(left.lines)).toContain("Hardware acceleration disabled (crash marker or --disable-gpu)");
		},
		SPAN,
	);

	it(
		"never relaunches a launch started with --disable-gpu",
		async () => {
			await launch({ args: ["--disable-gpu"] }, async shell => {
				expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: true });
				await gone(shell);
				await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (software)"));
				expect(shell.process.exitCode).toBeNull();
				expect(await softwareCompositing()).toBe(true);
			});
		},
		SPAN,
	);

	it(
		"relaunches a hardware launch once into software, and that launch then stays up",
		async () => {
			let first: Left | undefined;
			const shell = await startTestShell(exe as string, {
				env: { OMP_GUI_HEADLESS: "", OMP_GUI_LAUNCH_GUARD: "1", OMP_GUI_TEST_GPU_GONE: "1" },
			});
			try {
				pointChromeAt(() => shell.client);
				await gone(shell);
				expect(await exitOf(shell)).toBe(0);
				first = leftBy(shell);
			} finally {
				await shell.close().catch(() => {});
			}
			expect(first?.marker).toMatchObject({ reason: "crashed", exitCode: crash.exitCode, policy: 2 });
			expect(first?.history?.at(-1)).toHaveProperty("gpuRelaunchAt");
			expect(messages(first?.lines ?? [])).toContain(
				"GPU process exited (crashed): relaunching with software rendering",
			);

			const second = await launch(
				{ seeds: { marker: JSON.stringify(first?.marker), history: JSON.stringify(first?.history) } },
				async shell => {
					expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: true });
					await gone(shell);
					await gone(shell);
					await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (software)"));
					expect(shell.process.exitCode).toBeNull();
				},
			);
			expect(messages(second.lines)).not.toContain("relaunching with software rendering");
		},
		SPAN * 2,
	);

	it(
		"relaunches at most once per 10 minutes, even when the user turns hardware acceleration back on",
		async () => {
			const history = JSON.stringify([{ at: Date.now() - 5000, gpuRelaunchAt: Date.now() - 4000 }]);
			const left = await launch(
				{
					args: ["--enable-gpu"],
					seeds: { history, marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }) },
				},
				async shell => {
					// --enable-gpu clears the marker, so this launch is a hardware one again; its GPU process dies too.
					expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
					await gone(shell);
					await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (cooldown)"));
					expect(shell.process.exitCode).toBeNull();
				},
			);
			// The marker is written, so the next plain launch renders in software.
			expect(left.marker).toMatchObject({ reason: "crashed", policy: 2 });
		},
		SPAN,
	);

	it(
		"never relaunches in safe mode, which renders in software whatever the switches say",
		async () => {
			await launch({ args: ["--enable-gpu"], seeds: { history: unstable(3) } }, async shell => {
				expect(await shell.client.call("chrome.safeMode", {})).toEqual({ safeMode: true, software: true });
				await gone(shell);
				await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (safe-mode)"));
				expect(shell.process.exitCode).toBeNull();
			});
		},
		SPAN,
	);

	it(
		"never relaunches a test launch (OMP_GUI_HEADLESS): nothing follows the new process, which outlives the test",
		async () => {
			const left = await launch({ env: { OMP_GUI_HEADLESS: "1" } }, async shell => {
				await gone(shell);
				await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (test-launch)"));
				expect(shell.process.exitCode).toBeNull();
			});
			expect(messages(left.lines)).toContain("no relaunch (test-launch); Chromium restarts it");
		},
		SPAN,
	);

	it(
		"a crash that is no GPU failure (killed, a clean exit) changes nothing",
		async () => {
			const left = await launch({}, async shell => {
				await gone(shell, { reason: "killed", exitCode: 1073807364 });
				await gone(shell, { reason: "clean-exit", exitCode: 0 });
				// A later real crash is still the launch's first.
				await gone(shell, { reason: "crashed", exitCode: -1, upMs: 1000 });
				expect(await exitOf(shell)).toBe(0);
			});
			expect(left.marker).toMatchObject({ reason: "crashed" });
		},
		SPAN,
	);
});

describe.skipIf(!exe)("a crash in a launch that has run for a while", () => {
	const settled = 40 * 60_000;

	it(
		"leaves the first crash of a settled hardware launch to Chromium: no relaunch, no marker, hardware next time",
		async () => {
			const left = await launch({}, async shell => {
				await gone(shell, { ...crash, upMs: settled });
				await vi.waitFor(() =>
					expect(messages(lines(shell))).toContain("Chromium restarts it, hardware acceleration stays"),
				);
				expect(shell.process.exitCode).toBeNull();
			});
			expect(left.marker).toBeNull();
		},
		SPAN,
	);

	it(
		"a second crash within the cooldown of the first is a GPU that keeps dying: marker and relaunch",
		async () => {
			await launch({}, async shell => {
				await gone(shell, { ...crash, upMs: settled });
				await gone(shell, { ...crash, upMs: settled + 30_000 });
				expect(await exitOf(shell)).toBe(0);
			});
		},
		SPAN,
	);

	it(
		"an early crash still relaunches into software",
		async () => {
			const left = await launch({}, async shell => {
				await gone(shell, { ...crash, upMs: 3_000 });
				expect(await exitOf(shell)).toBe(0);
			});
			expect(left.marker).toMatchObject({ policy: 2 });
		},
		SPAN,
	);
});

describe.skipIf(!exe)("hardware acceleration comes back by itself", () => {
	it(
		"tries hardware once again after a 7-day cool-off, and keeps it when that launch stays up",
		async () => {
			const eightDaysAgo = marker({ reason: "crashed", exitCode: -1, policy: 2 }, Date.now() - 8 * DAY);
			const left = await launch({ seeds: { marker: eightDaysAgo } }, async shell => {
				expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
				const trial = readJson<Record<string, unknown>>(path.join(shell.userData, "gpu-fallback.json"));
				// Recorded before it runs, so a trial that never gets a verdict is not repeated.
				expect(trial).toHaveProperty("trialAt");
				// 20 s up: the verdict.
				await vi.waitFor(() => expect(existsSync(path.join(shell.userData, "gpu-fallback.json"))).toBe(false), {
					timeout: 40_000,
					interval: 500,
				});
			});
			expect(messages(left.lines)).toContain("trying hardware acceleration again (cool-off)");
			expect(messages(left.lines)).toContain("GPU crash marker cleared: hardware acceleration works again");
		},
		SPAN * 2,
	);

	it(
		"a marker an older build wrote (every crash, mid-run ones included) gets one hardware trial under this policy",
		async () => {
			const older = marker({ reason: "crashed", exitCode: 34 });
			const left = await launch({ seeds: { marker: older } }, async shell => {
				expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
			});
			expect(messages(left.lines)).toContain("trying hardware acceleration again (policy)");
		},
		SPAN,
	);

	it(
		"a crash in the trial goes back to software without a second relaunch inside the cap",
		async () => {
			const history = JSON.stringify([{ at: Date.now() - 60_000, gpuRelaunchAt: Date.now() - 50_000 }]);
			const left = await launch(
				{ seeds: { history, marker: marker({ reason: "crashed", policy: 1 }) } },
				async shell => {
					await gone(shell, { ...crash, upMs: 5_000 });
					await vi.waitFor(() => expect(messages(lines(shell))).toContain("no relaunch (cooldown)"));
					expect(shell.process.exitCode).toBeNull();
				},
			);
			expect(left.marker).toMatchObject({ reason: "crashed", policy: 2 });
			expect(left.marker).not.toHaveProperty("trialAt");
		},
		SPAN,
	);

	it(
		"a killed marker is stale and goes; an unreadable one stays, and like any marker without this policy gets one hardware trial",
		async () => {
			const stale = await launch(
				{ seeds: { marker: marker({ reason: "killed", exitCode: 1073807364 }) } },
				async shell => {
					expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
				},
			);
			expect(stale.marker).toBeNull();
			// gpu-fallback-core.ts: markerForcesSoftware("not json") is true (not stale), and its policy is unknown, so
			// markerDecision tries hardware once and records the trial before it runs.
			const unreadable = await launch({ seeds: { marker: "not json" } }, async shell => {
				expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
			});
			expect(messages(unreadable.lines)).toContain("trying hardware acceleration again (policy)");
			expect(unreadable.marker).toMatchObject({ policy: 2, trialAt: expect.any(Number) });
		},
		SPAN * 2,
	);

	it(
		"--enable-gpu clears a stale marker",
		async () => {
			const left = await launch(
				{ args: ["--enable-gpu"], seeds: { marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }) } },
				async shell => {
					expect(await shell.client.call("chrome.safeMode", {})).toMatchObject({ software: false });
				},
			);
			expect(left.marker).toBeNull();
		},
		SPAN,
	);
});

describe.skipIf(!exe)("the rendering mode", () => {
	it(
		"a launch that turned hardware off says so once, and logs it once",
		async () => {
			const left = await launch({ args: ["--disable-gpu"] }, async shell => {
				expect(await softwareCompositing()).toBe(true);
				expect(await softwareCompositing()).toBe(true);
				expect(await shell.client.call("chrome.rendering", {})).toEqual({ software: true });
			});
			expect(left.lines.filter(line => line.message.startsWith("gpu_compositing:"))).toHaveLength(1);
			expect(messages(left.lines)).toContain("gpu_compositing: disabled_software (software)");
		},
		SPAN,
	);
});
