/**
 * The quit prompt (app-quit.ts): with Continue interrupted work off, ⌘Q while a turn runs asks before stopping it;
 * "Quit anyway" quits, "Keep working" (the default and the cancel) does not, and ⌘Q again while it asks queues
 * nothing. With the setting on, nothing asks.
 */
import type { MessageBoxOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MAIN_TEXT from "../../native/ompdesk/crates/shell/src/boot_core/main-text.json";
import { fillText } from "../shared/fill-text";
import { confirmQuit, confirmUpdateRestart, installQuitGuard, requestQuit, setQuitResumes } from "./app-quit";
import { QUIT_EXIT_TIMEOUT_MS } from "./quit-watchdog";
import type { MainTextKey } from "./shell-host/modules/boot";

const electron = vi.hoisted(() => {
	const beforeQuit: Array<(event: { preventDefault(): void }) => void> = [];
	const willQuit: Array<(event: { preventDefault(): void }) => void> = [];
	return {
		beforeQuit,
		willQuit,
		quit: vi.fn(),
		exit: vi.fn(),
		log: vi.fn(),
		showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<{ response: number }>>(),
	};
});

vi.mock("electron", () => ({
	app: {
		on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
			if (name === "before-quit") electron.beforeQuit.push(listener);
			if (name === "will-quit") electron.willQuit.push(listener);
		},
		quit: electron.quit,
		exit: electron.exit,
	},
	autoUpdater: { on: () => {} },
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: electron.showMessageBox },
}));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: electron.log }));
// The shell pushes main's text (`boot.labels`); here the table itself stands in.
vi.mock("./shell-host/modules/boot", () => ({
	getMainLanguage: () => "en",
	mainT: (key: MainTextKey, _language: string, params?: Record<string, number>) => fillText(MAIN_TEXT[key].en, params),
}));

let working = true;
const ompsExited = Promise.withResolvers<void>();
installQuitGuard(
	() => [
		{ windowId: 1, tabId: "a", inFlight: working },
		{ windowId: 1, tabId: "b", inFlight: false },
	],
	() => {},
	async () => {},
	() => ompsExited.promise,
);

beforeEach(() => {
	working = true;
	setQuitResumes(() => false);
	electron.showMessageBox.mockReset();
	electron.quit.mockReset();
	electron.exit.mockReset();
	electron.log.mockReset();
});

describe("confirmQuit", () => {
	it("asks while a turn runs and the setting is off, and only 'Quit anyway' quits", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await confirmQuit()).toBe(true);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
			type: "warning",
			buttons: ["Quit anyway", "Keep working"],
			defaultId: 1,
			cancelId: 1,
			message: "Sessions are still running",
			detail: "Still working: 1 of 2 sessions, in 1 window. Quitting stops them and their agents.",
		});
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await confirmQuit()).toBe(false);
	});

	it("asks nothing when no turn runs, or when the running turns continue after the next launch", async () => {
		working = false;
		expect(await confirmQuit()).toBe(true);
		working = true;
		setQuitResumes(() => true);
		expect(await confirmQuit()).toBe(true);
		expect(electron.showMessageBox).not.toHaveBeenCalled();
	});

	it("a second quit while the prompt is open queues no second prompt", async () => {
		const answer = Promise.withResolvers<{ response: number }>();
		electron.showMessageBox.mockReturnValueOnce(answer.promise);
		const first = confirmQuit();
		expect(await confirmQuit()).toBe(false);
		answer.resolve({ response: 1 });
		expect(await first).toBe(false);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("⌘Q goes through the prompt: the quit is held, and 'Quit anyway' quits", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		const preventDefault = vi.fn();
		for (const listener of electron.beforeQuit) listener({ preventDefault });
		expect(preventDefault).toHaveBeenCalled();
		await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(1));
	});
});

describe("confirmUpdateRestart", () => {
	const none = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };
	const work = {
		subagents: 2,
		jobs: 1,
		subagentLabels: ["LayoutSplit", "StreamFast"],
		jobLabels: ["dev server"],
	};

	it("with Continue interrupted work on names the background work it would start over, and Restart goes ahead", async () => {
		setQuitResumes(() => true);
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await confirmUpdateRestart(async () => work)).toBe(true);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
			type: "warning",
			buttons: ["Restart", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			message: "Background work is still running",
			detail:
				"2 subagents (LayoutSplit, StreamFast) and 1 background job (dev server) will be interrupted and started again after the restart.",
		});
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await confirmUpdateRestart(async () => work)).toBe(false);
	});

	it("with it on asks nothing for a running turn alone", async () => {
		setQuitResumes(() => true);
		expect(await confirmUpdateRestart(async () => none)).toBe(true);
		expect(electron.showMessageBox).not.toHaveBeenCalled();
	});

	it("with it off keeps the quit prompt for running work and never reads the omps", async () => {
		const read = vi.fn(async () => work);
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await confirmUpdateRestart(read)).toBe(false);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({ buttons: ["Quit anyway", "Keep working"] });
		expect(read).not.toHaveBeenCalled();
		working = false;
		expect(await confirmUpdateRestart(read)).toBe(true);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("a second click while the prompt is open queues no second prompt", async () => {
		setQuitResumes(() => true);
		const answer = Promise.withResolvers<{ response: number }>();
		electron.showMessageBox.mockReturnValueOnce(answer.promise);
		const first = confirmUpdateRestart(async () => work);
		await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledTimes(1));
		expect(await confirmUpdateRestart(async () => work)).toBe(false);
		answer.resolve({ response: 0 });
		expect(await first).toBe(true);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});
});

describe("quit watchdog wiring", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("an approved quit that never ends is forced out after the deadline, and logs it", async () => {
		const fire = () => {
			for (const listener of electron.beforeQuit) listener({ preventDefault: () => {} });
		};
		requestQuit();
		// The first pass runs finalize and re-quits; only the committed pass arms the watchdog.
		fire();
		await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(2));
		vi.useFakeTimers();
		fire();
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS - 1);
		expect(electron.exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(electron.exit).toHaveBeenCalledWith(0);
		expect(electron.log).toHaveBeenCalledWith(expect.objectContaining({ source: "background-task" }));
	});
});

describe("the exit waits for every omp", () => {
	it("holds the exit in will-quit until every omp has exited, then exits once", async () => {
		const prevented = vi.fn();
		for (const listener of electron.willQuit) listener({ preventDefault: prevented });
		expect(prevented).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(electron.exit).not.toHaveBeenCalled();
		ompsExited.resolve();
		await vi.waitFor(() => expect(electron.exit).toHaveBeenCalledWith(0));
		// app.exit skips a second will-quit; one that came anyway lets it through.
		const again = vi.fn();
		for (const listener of electron.willQuit) listener({ preventDefault: again });
		expect(again).not.toHaveBeenCalled();
	});
});
