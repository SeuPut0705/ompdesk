/**
 * The window area (`src/main/window.ts` and its rule files): the pure rules row by row, and `WindowManager` driven over
 * the fake shell (the frames a window's creation, first show, close and run progress sent).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastWindowCloseAction } from "../../../src/main/quit-guard";
import {
	applicationResourcesChanged,
	RENDERER_RECOVERY_COOLDOWN_MS,
	shouldReloadRenderer,
	shouldRestartForChangedResources,
} from "../../../src/main/renderer-recovery";
import { WindowManager } from "../../../src/main/window";
import { isReachable, restoreWithinDisplays } from "../../../src/main/window-bounds";
import { micaSupported, windowChromeOptions } from "../../../src/main/window-chrome";
import type { Step } from "../capture-chrome";
import { type FakeShell, fakeShell } from "./fake-shell";

const AREAS = {
	one: [{ x: 0, y: 25, width: 1920, height: 1055 }],
	two: [
		{ x: 0, y: 25, width: 1920, height: 1055 },
		{ x: 1920, y: 0, width: 1280, height: 984 },
	],
	small: [{ x: 0, y: 0, width: 300, height: 200 }],
	none: [],
};

const RECTS = [
	{ x: 100, y: 100, width: 1400, height: 900 },
	{ x: 1900, y: 100, width: 1400, height: 900 },
	{ x: 1870, y: 100, width: 1400, height: 900 },
	{ x: 1861, y: 100, width: 1400, height: 900 },
	{ x: 3500, y: 100, width: 800, height: 600 },
	{ x: -1500, y: -900, width: 1400, height: 900 },
	{ x: 100, y: 1079, width: 800, height: 600 },
	{ x: 100, y: 1054, width: 800, height: 600 },
	{ x: 100, y: -27, width: 800, height: 600 },
	{ x: 100, y: -28, width: 800, height: 600 },
	{ x: 2500, y: 984, width: 800, height: 600 },
	{ x: 10, y: 10, width: 5000, height: 4000 },
	{ x: 100.5, y: 100.5, width: 801, height: 601 },
];

function pure(): Step[] {
	const steps: Step[] = [];
	for (const [name, areas] of Object.entries(AREAS)) {
		for (const rect of RECTS) {
			steps.push({
				fn: "src/main/window-bounds.ts#restoreWithinDisplays",
				input: { rect, workAreas: areas, name },
				output: restoreWithinDisplays(rect, areas),
			});
			steps.push({
				fn: "src/main/window-bounds.ts#isReachable",
				input: { rect, workAreas: areas },
				output: isReachable(rect, areas),
			});
		}
	}
	for (const platform of ["darwin", "win32", "linux"] as const) {
		for (const dark of [false, true]) {
			for (const mica of [false, true]) {
				steps.push({
					fn: "src/main/window-chrome.ts#windowChromeOptions",
					input: { platform, dark, mica },
					output: windowChromeOptions(platform, dark, mica),
				});
			}
		}
	}
	for (const [platform, release] of [
		["win32", "10.0.22621"],
		["win32", "10.0.22620"],
		["win32", "10.0.26100"],
		["win32", "10.0.19045"],
		["win32", "10.0"],
		["win32", ""],
		["darwin", "25.0.0"],
	] as const) {
		steps.push({
			fn: "src/main/window-chrome.ts#micaSupported",
			input: { platform, release },
			output: micaSupported(platform, release),
		});
	}
	const reasons = ["clean-exit", "crashed", "killed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"];
	for (const reason of reasons) {
		for (const [last, now] of [
			[0, 1_000_000],
			[1_000_000, 1_000_000 + RENDERER_RECOVERY_COOLDOWN_MS - 1],
			[1_000_000, 1_000_000 + RENDERER_RECOVERY_COOLDOWN_MS],
		]) {
			steps.push({
				fn: "src/main/renderer-recovery.ts#shouldReloadRenderer",
				input: { reason, lastRecoveryAt: last, now },
				output: shouldReloadRenderer(reason as never, last, now),
			});
		}
	}
	const identity = { device: 1, inode: 2, size: 3, modifiedAt: 4.5 };
	for (const [launch, current] of [
		[null, null],
		[null, identity],
		[identity, null],
		[identity, identity],
		[identity, { ...identity, device: 9 }],
		[identity, { ...identity, inode: 9 }],
		[identity, { ...identity, size: 9 }],
		[identity, { ...identity, modifiedAt: 4.50001 }],
	] as const) {
		steps.push({
			fn: "src/main/renderer-recovery.ts#applicationResourcesChanged",
			input: { launch, current },
			output: applicationResourcesChanged(launch, current),
		});
	}
	for (const failure of [
		{ kind: "console-error" },
		{ kind: "main-frame-navigation" },
		{ kind: "load-failure", mainFrame: true },
		{ kind: "load-failure", mainFrame: false },
		{ kind: "process-gone", reloadable: true },
		{ kind: "process-gone", reloadable: false },
	] as const) {
		steps.push({
			fn: "src/main/renderer-recovery.ts#shouldRestartForChangedResources",
			input: failure,
			output: shouldRestartForChangedResources(failure),
		});
	}
	for (const platform of ["darwin", "win32", "linux"] as const) {
		for (const quitApproved of [false, true]) {
			for (const closeToTray of [false, true]) {
				steps.push({
					fn: "src/main/quit-guard.ts#lastWindowCloseAction",
					input: { platform, quitApproved, closeToTray },
					output: lastWindowCloseAction({ platform, quitApproved, closeToTray }),
				});
			}
		}
	}
	return steps;
}

const SAVED = {
	none: undefined,
	size: { width: 1200, height: 800 },
	placed: { x: 40, y: 60, width: 1200, height: 800, isMaximized: false },
	maximized: { x: 40, y: 60, width: 1200, height: 800, isMaximized: true },
	unplugged: { x: 4000, y: 60, width: 1200, height: 800, isMaximized: false },
};

/** What `createWindow` sends for each saved geometry, as the first and as the third window (cascade). */
async function creation(): Promise<Step[]> {
	const steps: Step[] = [];
	for (const saved of Object.values(SAVED)) {
		for (const before of [0, 2]) {
			const shell: FakeShell = await fakeShell();
			if (saved) writeFileSync(join(shell.userData, "window-state.json"), JSON.stringify({ windowState: saved }));
			const manager = new WindowManager();
			for (let i = 0; i < before; i += 1) manager.createWindow({ cwd: `/work/${i}` });
			await shell.settle();
			shell.take();
			const win = manager.createWindow({ cwd: "/work/new" });
			await shell.settle();
			steps.push({
				fn: "src/main/window.ts#createWindow",
				input: { saved: saved ?? null, before, platform: process.platform, dark: false, headless: false },
				output: { frames: shell.take(), record: manager.recordFor(win) && { slot: manager.recordFor(win)?.slot } },
			});
			shell.close();
		}
	}
	return steps;
}

/** The first show for each relaunch presence: `ready-to-show` and `did-finish-load`, whichever comes first. */
async function firstShow(): Promise<Step[]> {
	const steps: Step[] = [];
	for (const presence of [null, "hidden", "minimized", "behind"] as const) {
		for (const first of ["ready-to-show", "did-finish-load"] as const) {
			const shell = await fakeShell();
			const manager = new WindowManager();
			manager.launchPresence = presence;
			const win = manager.createWindow({ cwd: "/work" });
			await shell.settle();
			shell.take();
			if (first === "ready-to-show")
				await shell.emit("win.event", { winId: win.id, name: "ready-to-show", args: [] });
			else await shell.emit("wc.event", { wcId: win.webContents.id, name: "did-finish-load", args: [] });
			await shell.emit("win.event", { winId: win.id, name: "ready-to-show", args: [] });
			await shell.emit("wc.event", { wcId: win.webContents.id, name: "did-finish-load", args: [] });
			steps.push({
				fn: "src/main/window.ts#showOnFirstPaint",
				input: { presence, first },
				output: shell.take().filter(frame => frame.method === "win.op"),
			});
			shell.close();
		}
	}
	return steps;
}

/** What a close of the last shown window does, per `lastWindowClose` answer, and the geometry it saves. */
async function closing(): Promise<Step[]> {
	const steps: Step[] = [];
	for (const action of ["close", "hide", "quit"] as const) {
		for (const others of [0, 1]) {
			const shell = await fakeShell();
			const manager = new WindowManager();
			const hidden: number[] = [];
			manager.lastWindowClose = () => action;
			manager.lastWindowHidden = () => hidden.push(1);
			const other = others ? manager.createWindow({ cwd: "/other" }) : null;
			const win = manager.createWindow({ cwd: "/work" });
			await shell.settle();
			if (other) await shell.emit("win.state", { winId: other.id, visible: true });
			await shell.emit("win.state", {
				winId: win.id,
				visible: true,
				maximized: true,
				bounds: { x: 11, y: 22, width: 1333, height: 777 },
			});
			shell.take();
			const answer = await shell.ask("win.closeRequested", { winId: win.id });
			await shell.settle();
			steps.push({
				fn: "src/main/window.ts#close",
				input: { action, otherVisible: others === 1 },
				output: {
					answer,
					frames: shell.take().filter(frame => frame.method === "win.op"),
					hiddenNotice: hidden.length,
					saved: JSON.parse(readFileSync(join(shell.userData, "window-state.json"), "utf8")),
				},
			});
			shell.close();
		}
	}
	return steps;
}

async function runProgress(): Promise<Step[]> {
	const steps: Step[] = [];
	for (const state of ["working", "waiting", "idle"] as const) {
		const shell = await fakeShell();
		const manager = new WindowManager();
		manager.createWindow({ cwd: "/a" });
		manager.createWindow({ cwd: "/b" });
		await shell.settle();
		shell.take();
		manager.setRunProgress(state);
		await shell.settle();
		steps.push({
			fn: "src/main/window.ts#setRunProgress",
			input: { state },
			output: shell.take().filter(frame => frame.method === "app.setBadge" || frame.params !== undefined),
		});
		shell.close();
	}
	return steps;
}

export async function capture(): Promise<Step[]> {
	return [...pure(), ...(await creation()), ...(await firstShow()), ...(await closing()), ...(await runProgress())];
}
