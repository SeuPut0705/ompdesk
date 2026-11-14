/**
 * The quit against the real shell (PROTOCOL.md §15.3; was `app-quit.test.ts` and `quit-watchdog.test.ts`): with
 * Continue interrupted work off, ⌘Q while a turn runs asks before stopping it; "Quit anyway" quits, "Keep working"
 * (the default and the cancel) does not, and ⌘Q again while it asks queues nothing. With the setting on, nothing asks.
 * A committed quit that never ends is forced out by the shell's watchdog.
 *
 * A headless run cannot click a native box: the shell's test seam `OMP_GUI_TEST_QUIT_DIALOG=<button>` answers a
 * confirmation after 300 ms and logs the options it would have shown (`quit.test_dialog`), which the cases read.
 * `chrome_core::quit`'s captured replay holds the dialogs' text in both languages.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MessageBoxOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_TEXT } from "../../i18n-text";
import type { WindowTabFact } from "../../quit-guard";
import type * as Quit from "./chrome-quit";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const electron = vi.hoisted(() => {
	type Listener = (event: { preventDefault(): void }) => void;
	return {
		beforeQuit: [] as Listener[],
		willQuit: [] as Listener[],
		updateQuit: [] as Array<() => void>,
		quit: vi.fn(),
		exit: vi.fn(),
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
	autoUpdater: { on: (_name: string, listener: () => void) => electron.updateQuit.push(listener) },
}));
// The real ./i18n opens the prefs store at load; the text table is what matters here.
vi.mock("../../i18n", () => ({
	getMainLanguage: () => "en",
	mainT: (key: keyof typeof MAIN_TEXT, _language: string, params?: Record<string, number>) =>
		fill(MAIN_TEXT[key].en, params),
}));

function fill(template: string, params?: Record<string, number>): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		if (!params) return match;
		if (name === "plural") return params.count === 1 ? "" : "s";
		if (name.endsWith("Plural")) return params[name.slice(0, -"Plural".length)] === 1 ? "" : "s";
		return name in params ? String(params[name]) : match;
	});
}

const exe = testShellExecutable();

const shells: TestShell[] = [];
afterEach(async () => {
	for (const shell of shells.splice(0)) await shell.close().catch(() => undefined);
});

interface Session {
	shell: TestShell;
	quit: typeof Quit;
	/** Tabs the sidecars report. */
	inventory: { facts: WindowTabFact[] };
	finalized: ReturnType<typeof vi.fn>;
	ompsExited: PromiseWithResolvers<void>;
}

/**
 * One shell and a fresh copy of the client over it. Static imports cannot work: the client keeps module state (the
 * approval mirror, the forced-exit hooks) that one case must not leave to the next.
 */
async function session(env: Record<string, string>): Promise<Session> {
	if (!exe) throw new Error("no shell");
	const shell = await startTestShell(exe, { env: { OMP_GUI_HEADLESS: "1", ...env } });
	shells.push(shell);
	const text: Record<string, string> = {};
	for (const [key, value] of Object.entries(MAIN_TEXT)) text[key] = value.en;
	await shell.client.event("i18n.labels", { language: "en", text });
	vi.resetModules();
	electron.beforeQuit.length = 0;
	electron.willQuit.length = 0;
	electron.updateQuit.length = 0;
	electron.quit.mockReset();
	electron.exit.mockReset();
	const { pointChromeAt } = await import("./chrome");
	pointChromeAt(() => shell.client);
	const quit = await import("./chrome-quit");
	const inventory = {
		facts: [
			{ windowId: 1, tabId: "a", inFlight: true },
			{ windowId: 1, tabId: "b", inFlight: false },
		],
	};
	shell.client.handle("core.call", ({ method }: { method: string }) => {
		if (method !== "pool.tabInventory") throw new Error(`unexpected core request ${method}`);
		return inventory.facts;
	});
	const finalized = vi.fn(async () => {});
	const ompsExited = Promise.withResolvers<void>();
	quit.installQuitGuard(
		() => inventory.facts,
		() => {},
		finalized,
		() => ompsExited.promise,
	);
	quit.setQuitResumes(() => false);
	return { shell, quit, inventory, finalized, ompsExited };
}

/** A real wall-clock wait (the shell answers on its own clock; only the absence of an event proves a "not"). */
function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** The shell's exit code, once it exits. */
function exitOf(shell: TestShell): Promise<number | null> {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	shell.process.once("exit", code => resolve(code));
	return promise;
}

/** The boxes the shell would have shown, from its log. */
function dialogsSeen(shell: TestShell): MessageBoxOptions[] {
	const log = readFileSync(path.join(shell.userData, "shell-webview", "shell.log.jsonl"), "utf8");
	return log
		.split("\n")
		.filter(line => line.includes('"quit.test_dialog"'))
		.map(line => (JSON.parse(line) as { options: MessageBoxOptions }).options);
}

const none = { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] };
const work = {
	subagents: 2,
	jobs: 1,
	subagentLabels: ["LayoutSplit", "StreamFast"],
	jobLabels: ["dev server"],
};

describe.skipIf(!exe)("confirmQuit", () => {
	it("asks while a turn runs and the setting is off, and only 'Quit anyway' quits", async () => {
		const anyway = await session({ OMP_GUI_TEST_QUIT_DIALOG: "0" });
		expect(await anyway.quit.confirmQuit()).toBe(true);
		expect(dialogsSeen(anyway.shell)[0]).toMatchObject({
			type: "warning",
			buttons: ["Quit anyway", "Keep working"],
			defaultId: 1,
			cancelId: 1,
			message: "Sessions are still running",
			detail: "Still working: 1 of 2 sessions, in 1 window. Quitting stops them and their agents.",
		});
		const keep = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		expect(await keep.quit.confirmQuit()).toBe(false);
		expect(dialogsSeen(keep.shell)).toHaveLength(1);
	});

	it("asks nothing when no turn runs, or when the running turns continue after the next launch", async () => {
		// The box would answer 'Keep working': a true answer is a quit nobody asked about.
		const idle = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		idle.inventory.facts = [{ windowId: 1, tabId: "a", inFlight: false }];
		expect(await idle.quit.confirmQuit()).toBe(true);
		idle.inventory.facts = [{ windowId: 1, tabId: "a", inFlight: true }];
		idle.quit.setQuitResumes(() => true);
		expect(await idle.quit.confirmQuit()).toBe(true);
		expect(dialogsSeen(idle.shell)).toHaveLength(0);
	});

	it("a second quit while the prompt is open queues no second prompt", async () => {
		const open = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		const first = open.quit.confirmQuit();
		await vi.waitFor(() => expect(dialogsSeen(open.shell)).toHaveLength(1));
		expect(await open.quit.confirmQuit()).toBe(false);
		expect(await first).toBe(false);
		expect(dialogsSeen(open.shell)).toHaveLength(1);
	});

	it("⌘Q goes through the prompt: the quit is held, and 'Quit anyway' quits", async () => {
		const anyway = await session({ OMP_GUI_TEST_QUIT_DIALOG: "0" });
		const preventDefault = vi.fn();
		for (const listener of electron.beforeQuit) listener({ preventDefault });
		expect(preventDefault).toHaveBeenCalled();
		await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(1));
		expect(anyway.quit.quitApproved()).toBe(true);
		expect(dialogsSeen(anyway.shell)).toHaveLength(1);
	});

	it("⌘Q answered 'Keep working' stays held and approves nothing", async () => {
		const keep = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		const preventDefault = vi.fn();
		for (const listener of electron.beforeQuit) listener({ preventDefault });
		await vi.waitFor(() => expect(dialogsSeen(keep.shell)).toHaveLength(1));
		await wait(600);
		expect(preventDefault).toHaveBeenCalled();
		expect(electron.quit).not.toHaveBeenCalled();
		expect(keep.quit.quitApproved()).toBe(false);
	});
});

describe.skipIf(!exe)("confirmUpdateRestart", () => {
	it("with Continue interrupted work on names the background work it would start over, and Restart goes ahead", async () => {
		const restart = await session({ OMP_GUI_TEST_QUIT_DIALOG: "0" });
		restart.quit.setQuitResumes(() => true);
		expect(await restart.quit.confirmUpdateRestart(async () => work)).toBe(true);
		expect(dialogsSeen(restart.shell)[0]).toMatchObject({
			type: "warning",
			buttons: ["Restart", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			message: "Background work is still running",
			detail:
				"2 subagents (LayoutSplit, StreamFast) and 1 background job (dev server) will be interrupted and started again after the restart.",
		});
		const cancel = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		cancel.quit.setQuitResumes(() => true);
		expect(await cancel.quit.confirmUpdateRestart(async () => work)).toBe(false);
	});

	it("with it on asks nothing for a running turn alone", async () => {
		const quiet = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		quiet.quit.setQuitResumes(() => true);
		expect(await quiet.quit.confirmUpdateRestart(async () => none)).toBe(true);
		expect(dialogsSeen(quiet.shell)).toHaveLength(0);
	});

	it("with it off keeps the quit prompt for running work and never reads the omps", async () => {
		const keep = await session({ OMP_GUI_TEST_QUIT_DIALOG: "1" });
		const read = vi.fn(async () => work);
		expect(await keep.quit.confirmUpdateRestart(read)).toBe(false);
		expect(dialogsSeen(keep.shell)[0]).toMatchObject({ buttons: ["Quit anyway", "Keep working"] });
		expect(read).not.toHaveBeenCalled();
		keep.inventory.facts = [{ windowId: 1, tabId: "a", inFlight: false }];
		expect(await keep.quit.confirmUpdateRestart(read)).toBe(true);
		expect(dialogsSeen(keep.shell)).toHaveLength(1);
	});

	it("a second click while the prompt is open queues no second prompt", async () => {
		const open = await session({ OMP_GUI_TEST_QUIT_DIALOG: "0" });
		open.quit.setQuitResumes(() => true);
		const first = open.quit.confirmUpdateRestart(async () => work);
		await vi.waitFor(() => expect(dialogsSeen(open.shell)).toHaveLength(1));
		expect(await open.quit.confirmUpdateRestart(async () => work)).toBe(false);
		expect(await first).toBe(true);
		expect(dialogsSeen(open.shell)).toHaveLength(1);
	});
});

describe.skipIf(!exe)("quit watchdog wiring", () => {
	/** A quit approved and committed: the first `before-quit` pass runs finalize and re-quits, the second commits. */
	async function commit(open: Session): Promise<void> {
		const fire = () => {
			for (const listener of electron.beforeQuit) listener({ preventDefault: () => {} });
		};
		open.quit.requestQuit();
		fire();
		await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(2));
		fire();
	}

	it("an approved quit that never ends is forced out after the deadline, and logs it", async () => {
		const open = await session({ OMP_GUI_TEST_QUIT_WATCHDOG_MS: "1500" });
		const hook = vi.fn();
		open.quit.onQuitForcedExit(hook);
		const logged = Promise.withResolvers<{ report: Record<string, unknown> }>();
		open.shell.client.on("log.runtime", data => logged.resolve(data as { report: Record<string, unknown> }));
		const exited = exitOf(open.shell);
		await commit(open);
		expect(open.shell.process.exitCode).toBeNull();
		expect((await logged.promise).report).toMatchObject({
			source: "background-task",
			details: { watchdog: "quit", reason: "quit", timeoutMs: 1500 },
		});
		// Node ran its forced-exit hooks, then the shell ended itself with a clean code.
		expect(await exited).toBe(0);
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("a quit cancelled after it committed stops the force exit", async () => {
		const open = await session({ OMP_GUI_TEST_QUIT_WATCHDOG_MS: "800" });
		await commit(open);
		open.quit.disarmQuitWatchdog();
		// Past twice the shell's countdown: only the absence of an exit proves the disarm.
		await wait(1600);
		expect(open.shell.process.exitCode).toBeNull();
	});

	it("an update's quit commits on before-quit-for-update, and a disarm for another reason keeps it", async () => {
		const open = await session({ OMP_GUI_TEST_QUIT_WATCHDOG_MS: "800" });
		const exited = exitOf(open.shell);
		for (const listener of electron.updateQuit) listener();
		open.quit.disarmQuitWatchdog("quit");
		expect(await exited).toBe(0);
	});
});

describe.skipIf(!exe)("the exit waits for every omp", () => {
	it("holds the exit in will-quit until every omp has exited, then exits once", async () => {
		const open = await session({});
		const prevented = vi.fn();
		for (const listener of electron.willQuit) listener({ preventDefault: prevented });
		expect(prevented).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(electron.exit).not.toHaveBeenCalled();
		open.ompsExited.resolve();
		await vi.waitFor(() => expect(electron.exit).toHaveBeenCalledWith(0));
		// app.exit skips a second will-quit; one that came anyway lets it through.
		const again = vi.fn();
		for (const listener of electron.willQuit) listener({ preventDefault: again });
		expect(again).not.toHaveBeenCalled();
	});
});
