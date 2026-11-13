/**
 * The main-thread hang watchdog against the real shell (PROTOCOL.md §15.3; was `hang-watchdog.test.ts` and
 * `hang-watchdog-core.test.ts`): the shell's thread records a stall of over 5 s in `<userData>/logs/main-thread-hang.json`,
 * rewrites it as recovered when the heartbeats come back, and the next launch reports the previous marker as one
 * `main-thread-hang` line (the shell's own log keeps each runtime-log line as `chrome.runtime_log`: Node's file is
 * written later). The detector's and the step ring's cases are `chrome_core::hang`'s Rust tests and their captured
 * replay; the client's own rules (gated on packaged or `OMP_GUI_HANG_WATCHDOG=1`, never under vitest) run over a fake
 * host.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "../electron/host";
import { chrome, pointChromeAt } from "./chrome";
import { installHangWatchdog, markMainStep, stopHangWatchdog } from "./chrome-hang";
import { startTestShell, testShellExecutable } from "./test-shell";

const app = vi.hoisted(() => ({ isPackaged: true, once: vi.fn() }));
vi.mock("electron", () => ({ app }));

const exe = testShellExecutable();
const SPAN = 60_000;

function markerFile(userData: string): string {
	return path.join(userData, "logs", "main-thread-hang.json");
}

function readMarker(userData: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(markerFile(userData), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function reported(userData: string): Array<{ source: string; message: string; details: Record<string, unknown> }> {
	try {
		return readFileSync(path.join(userData, "shell-webview", "shell.log.jsonl"), "utf8")
			.split("\n")
			.flatMap(text => {
				try {
					const entry = JSON.parse(text) as {
						event?: string;
						source: string;
						message: string;
						details: Record<string, unknown>;
					};
					return entry.event === "chrome.runtime_log" ? [entry] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

describe.skipIf(!exe)("the main-thread hang watchdog", () => {
	it(
		"writes the phase and the steps main stalled in, oldest first, to the log of the next launch",
		async () => {
			const shell = await startTestShell(exe as string, {
				prepare: userData => {
					mkdirSync(path.dirname(markerFile(userData)), { recursive: true });
					writeFileSync(
						markerFile(userData),
						JSON.stringify({
							detectedAt: Date.parse("2026-10-20T01:38:33.839Z"),
							pid: 29292,
							unresponsiveMs: 5628,
							selfRecovered: true,
							phase: "update",
							steps: ["update:quit-and-install", "quit:teardown:sidecars"],
						}),
					);
				},
			});
			try {
				const [line] = reported(shell.userData);
				expect(line).toMatchObject({
					source: "main-thread-hang",
					message: "Main thread stalled for 6s and recovered",
					details: {
						unresponsiveMs: 5628,
						selfRecovered: true,
						previousPid: 29292,
						phase: "update",
						steps: "update:quit-and-install > quit:teardown:sidecars",
					},
				});
				// Consumed: reported once.
				expect(existsSync(markerFile(shell.userData))).toBe(false);
			} finally {
				await shell.close();
			}
		},
		SPAN,
	);

	it(
		"a stall over 5 s is recorded with the steps main posted, and the marker is rewritten when it recovers",
		async () => {
			const shell = await startTestShell(exe as string);
			try {
				pointChromeAt(() => shell.client);
				await chrome().post("heartbeat", { pid: 4242 });
				await chrome().post("step", { phase: "update", step: "quit-and-install" });
				await chrome().post("step", { phase: "quit", step: "teardown:sidecars" });
				// Silence: the shell's thread sees it while main is blocked.
				await vi.waitFor(() => expect(readMarker(shell.userData)).not.toBeNull(), {
					timeout: 15_000,
					interval: 250,
				});
				const stalled = readMarker(shell.userData);
				expect(stalled).toMatchObject({
					pid: 4242,
					selfRecovered: false,
					phase: "quit",
					steps: ["update:quit-and-install", "quit:teardown:sidecars"],
				});
				expect(stalled?.unresponsiveMs as number).toBeGreaterThan(5_000);

				await chrome().post("step", { phase: "running", step: "after" });
				await chrome().post("heartbeat", { pid: 4242 });
				await vi.waitFor(() => expect(readMarker(shell.userData)?.selfRecovered).toBe(true), {
					timeout: 5_000,
					interval: 100,
				});
				// One record per stall: the rewrite still names the step that stalled.
				expect(readMarker(shell.userData)).toMatchObject({ pid: 4242, phase: "quit" });
			} finally {
				await shell.close();
			}
		},
		SPAN,
	);

	it(
		"stays quiet while heartbeats keep coming, and after the watch ended",
		async () => {
			const shell = await startTestShell(exe as string);
			try {
				pointChromeAt(() => shell.client);
				for (let i = 0; i < 8; i++) {
					await chrome().post("heartbeat", { pid: 7 });
					// Real time: the watch runs on the shell's own thread and clock, which a fake timer here cannot advance.
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
				expect(readMarker(shell.userData)).toBeNull();
				// `will-quit`: no more heartbeats, and no more judging.
				await chrome().post("unwatch", {});
				// Real time: the watch runs on the shell's own thread and clock, which a fake timer here cannot advance.
				await new Promise(resolve => setTimeout(resolve, 7_000));
				expect(readMarker(shell.userData)).toBeNull();
			} finally {
				await shell.close();
			}
		},
		SPAN,
	);
});

describe("the hang watchdog's client", () => {
	const posts: Array<{ name: string; data: unknown }> = [];
	const host = {
		event: (name: string, data: unknown) => {
			posts.push({ name, data });
			return Promise.resolve();
		},
	} as unknown as HostClient;

	afterEach(() => {
		stopHangWatchdog();
		posts.length = 0;
		vi.useRealTimers();
		vi.unstubAllEnvs();
		app.isPackaged = true;
	});

	function beat(): void {
		pointChromeAt(() => host);
	}

	it("does nothing under vitest, and a step before the watchdog runs is dropped", () => {
		beat();
		installHangWatchdog();
		markMainStep("startup", "early");
		expect(posts).toEqual([]);
	});

	it("runs only in a packaged build or with OMP_GUI_HANG_WATCHDOG=1", () => {
		beat();
		vi.stubEnv("VITEST", "");
		app.isPackaged = false;
		installHangWatchdog();
		expect(posts).toEqual([]);
		vi.stubEnv("OMP_GUI_HANG_WATCHDOG", "1");
		installHangWatchdog();
		expect(posts).toEqual([{ name: "chrome.heartbeat", data: { pid: process.pid } }]);
	});

	it("beats at once and every second, posts the steps, and stops when asked", () => {
		beat();
		vi.useFakeTimers();
		vi.stubEnv("VITEST", "");
		installHangWatchdog();
		installHangWatchdog();
		expect(posts).toHaveLength(1);
		vi.advanceTimersByTime(3_000);
		expect(posts.filter(post => post.name === "chrome.heartbeat")).toHaveLength(4);
		markMainStep("quit", "teardown:sidecars");
		expect(posts.at(-1)).toEqual({ name: "chrome.step", data: { phase: "quit", step: "teardown:sidecars" } });
		stopHangWatchdog();
		expect(posts.at(-1)).toEqual({ name: "chrome.unwatch", data: {} });
		const count = posts.length;
		vi.advanceTimersByTime(5_000);
		markMainStep("quit", "late");
		expect(posts).toHaveLength(count);
	});
});
