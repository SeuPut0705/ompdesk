/**
 * Node's side of the app updater (updater.ts, PROTOCOL.md §15.8) over a fake host: the scheduler's decisions, the
 * restart confirm, the "installing" flag, the window presence an install records, and what Node does with each answer
 * of `updater.install`. "Restart & install" blocks the app for seconds (the installer starts and the app quits), so the
 * window must hear about it first, and a second click while it runs must start nothing: the user clicked twice, 5 s
 * apart, because nothing on screen said the first one had worked. What the shell does with a call (the release check,
 * the downloads, the swap) is its own parity suite's.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import MAIN_TEXT from "../../../../native/ompdesk/crates/shell/src/boot_core/main-text.json";
import { IPC_COMMANDS, type UpdateStatus } from "../../../shared/ipc-types";
import { type BackgroundWork, NO_BACKGROUND_WORK } from "../../background-work";
import { type IpcCaller, IpcRegistry } from "../../web/ipc-registry";
import type { HostClient } from "../electron/host";
import type { MainTextKey } from "./boot";
import type * as UpdaterModule from "./updater";

const mocks = vi.hoisted(() => {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const handlers = new Map<string, (params: unknown) => unknown>();
	const asked: unknown[] = [];
	const answer = { go: true };
	const calls: Array<{ method: string; params: unknown }> = [];
	const posts: Array<{ name: string; data: unknown }> = [];
	const replies = new Map<string, (params: unknown) => unknown>();
	const host: HostClient = {
		request: async (method, params) => ({ result: (await host.call(method, params)) as never }),
		call: async (method, params) => {
			calls.push({ method, params });
			const reply = replies.get(method);
			if (!reply) throw new Error(`no reply set for ${method}`);
			return reply(params) as never;
		},
		event: async (name, data) => {
			posts.push({ name, data });
		},
		handle: (method, handler) => {
			handlers.set(method, handler as (params: unknown) => unknown);
		},
		on: (name, listener) => {
			const own = listener as (data: unknown) => void;
			listeners.set(name, [...(listeners.get(name) ?? []), own]);
			return () =>
				listeners.set(
					name,
					(listeners.get(name) ?? []).filter(other => other !== own),
				);
		},
		flush: async () => {},
	};
	return {
		host,
		listeners,
		handlers,
		calls,
		posts,
		replies,
		/** `app.on("will-quit")`, `app.on("quit")` (with the exit code) and the quit watchdog's forced-exit hooks. */
		willQuit: [] as Array<() => void>,
		quit: [] as Array<(event: unknown, code: number) => void>,
		forcedExit: [] as Array<() => void>,
		/** What the quit path was asked to do, in order. */
		order: [] as string[],
		disarmed: [] as unknown[],
		sent: [] as UpdateStatus[],
		runtimeLog: [] as Array<{ message: string; details: Record<string, unknown> }>,
		userData: { dir: "" },
		windowVisible: true,
		/** `powerMonitor.getSystemIdleTimeAsync()`: seconds since anyone gave the computer input. */
		idleSeconds: 0,
		/** What the restart confirm is told: it reads the work like the real one, then answers `answer.go`. */
		confirmUpdateRestart: vi.fn(async (readWork: () => Promise<unknown>) => {
			asked.push(await readWork());
			return answer.go;
		}),
		asked,
		answer,
		loginEnv: {} as Record<string, string>,
	};
});

vi.mock("electron", () => ({
	app: {
		isPackaged: true,
		getVersion: () => "0.44.0",
		getPath: () => mocks.userData.dir,
		on: (event: string, listener: (event?: unknown, code?: number) => void) => {
			if (event === "will-quit") mocks.willQuit.push(listener);
			if (event === "quit") mocks.quit.push(listener);
		},
		quit: () => mocks.order.push("app.quit"),
	},
	autoUpdater: { emit: (event: string) => mocks.order.push(event) },
	BrowserWindow: {
		getAllWindows: () => [
			{
				isDestroyed: () => false,
				isVisible: () => mocks.windowVisible,
				isMinimized: () => false,
				isFocused: () => false,
				webContents: { send: (_channel: string, status: UpdateStatus) => mocks.sent.push(status) },
			},
		],
	},
	powerMonitor: { getSystemIdleTimeAsync: async () => mocks.idleSeconds },
	shellHost: mocks.host,
}));
vi.mock("./chrome-quit", () => ({
	confirmUpdateRestart: mocks.confirmUpdateRestart,
	disarmQuitWatchdog: (reason: unknown) => mocks.disarmed.push(reason),
	onQuitForcedExit: (hook: () => void) => mocks.forcedExit.push(hook),
	requestQuit: () => mocks.order.push("requestQuit"),
}));
vi.mock("./chrome-hang", () => ({ markMainStep: () => {} }));
vi.mock("./boot", () => ({
	mainT: (key: MainTextKey) => MAIN_TEXT[key].en,
}));
vi.mock("../../runtime-log", () => ({
	writeRuntimeLog: (report: { message: string; details: Record<string, unknown> }) => mocks.runtimeLog.push(report),
}));
vi.mock("../../shell-env", () => ({
	resolveLoginShellEnv: async () => ({ env: mocks.loginEnv, path: null, editor: null }),
	spawnPath: async () => "/login/bin:/usr/bin",
}));

const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
const VERSION = "0.45.0";
let updater: typeof UpdaterModule;
let registry: IpcRegistry;
let hostErrorClass: new (code: string, message: string) => Error;
let autoInstallOn = false;
/** What a click on "Restart & install" asks fresh: the running work the confirm names. */
const background = { work: NO_BACKGROUND_WORK as BackgroundWork };
/** The cards the probe reports open on this computer's tabs. */
const holds = { asking: false, planWaiting: false };

const SUBAGENTS: BackgroundWork = {
	subagents: 2,
	jobs: 0,
	subagentLabels: ["LayoutSplit", "StreamFast"],
	jobLabels: [],
};

/** `updater.install`'s answer; `then` is the wire's own name (parsed, as on the wire). */
function installAnswer(then: "quit" | "quit-for-update" | "none"): Record<string, string> {
	return JSON.parse(`{"then":"${then}"}`);
}

/** The shell's answer shape: a status with whether it can install and how this copy installs. */
function shellState(status: Record<string, unknown>, mode = "automatic", installable = mode !== "manual") {
	return { status, installable, mode };
}

/** An `updater.status` event from the shell. */
function emitStatus(status: Record<string, unknown>, mode = "automatic", installable = mode !== "manual"): void {
	emit("status", shellState(status, mode, installable));
}

function emit(name: string, data: unknown): void {
	for (const listener of mocks.listeners.get(`updater.${name}`) ?? []) listener(data);
}

const downloaded = (mode = "automatic") => emitStatus({ state: "downloaded", version: VERSION, mode }, mode);

/** Lets the promises a handler started settle (a decision that installs asks the shell first). */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Samples the idle time and lets the scheduler decide, then waits for an install it started. */
async function tick(): Promise<void> {
	await updater.appAutoUpdatePrefChanged();
	await settle();
}

function restartAndInstall(): Promise<unknown> {
	return registry.invoke(IPC_COMMANDS.UPDATER_APPLY, caller, []);
}

const installCalls = () => mocks.calls.filter(call => call.method === "updater.install");

const schedulerEvents = () =>
	mocks.runtimeLog.flatMap(report =>
		report.message === "scheduler"
			? [`${report.details.event}${report.details.reason ? `:${report.details.reason}` : ""}`]
			: [],
	);

/** A fresh copy of the module (its state is module-level) set up against the fake host, with an update downloaded. */
async function boot(replies: Record<string, (params: unknown) => unknown> = {}, seed = true): Promise<void> {
	mocks.calls.length = 0;
	mocks.posts.length = 0;
	mocks.listeners.clear();
	mocks.handlers.clear();
	mocks.willQuit.length = 0;
	mocks.quit.length = 0;
	mocks.forcedExit.length = 0;
	mocks.order.length = 0;
	mocks.disarmed.length = 0;
	mocks.sent.length = 0;
	mocks.runtimeLog.length = 0;
	mocks.replies.clear();
	mocks.replies.set("updater.start", () => shellState({ state: "idle" }));
	mocks.replies.set("updater.install", () => installAnswer("quit-for-update"));
	for (const [method, reply] of Object.entries(replies)) mocks.replies.set(method, reply);
	vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
	// The module's state is module-level: each test loads a fresh copy (a runtime choice a static import cannot make).
	vi.resetModules();
	updater = await import("./updater");
	hostErrorClass = (await import("../client")).HostError;
	registry = new IpcRegistry({ handle: () => {}, on: () => {} });
	updater.setupUpdater(registry, {
		enabled: () => autoInstallOn,
		resumes: () => true,
		busy: () => false,
		asking: () => holds.asking,
		planWaiting: () => holds.planWaiting,
		compacting: () => false,
		backgroundWork: async () => background.work,
	});
	await settle();
	mocks.sent.length = 0;
	if (seed) downloaded();
	background.work = NO_BACKGROUND_WORK;
	mocks.answer.go = true;
	mocks.asked.length = 0;
	mocks.confirmUpdateRestart.mockClear();
}

beforeAll(() => {
	// The scheduler reads `Date.now` once, at setup, and its tick is driven by the tests: no real interval may run.
	vi.useFakeTimers({ toFake: ["Date", "setInterval"] });
});

afterAll(() => {
	vi.useRealTimers();
});

beforeEach(async () => {
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-node-"));
	await boot();
});

afterEach(async () => {
	autoInstallOn = false;
	holds.asking = false;
	holds.planWaiting = false;
	mocks.idleSeconds = 0;
	mocks.windowVisible = true;
	await updater.appAutoUpdatePrefChanged();
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

describe("Restart & install with background work running", () => {
	it("asks with a fresh reading of the work and starts nothing when cancelled", async () => {
		background.work = SUBAGENTS;
		mocks.answer.go = false;
		await restartAndInstall();
		expect(mocks.asked).toEqual([SUBAGENTS]);
		expect(installCalls()).toHaveLength(0);
		mocks.answer.go = true;
		await restartAndInstall();
		expect(installCalls()).toHaveLength(1);
	});

	it("the automatic install does not wait for it: countdown at once, install at the deadline, no question", async () => {
		background.work = SUBAGENTS;
		autoInstallOn = true;
		await tick();
		await tick();
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await tick();
		expect(schedulerEvents()).toEqual(["safe", "countdown", "install"]);
		expect(installCalls().map(call => call.params)).toEqual([{ trigger: "auto", presence: "behind" }]);
		expect(mocks.confirmUpdateRestart).not.toHaveBeenCalled();
	});

	// Settings › Updates checks as it opens: a "checking" status in between made the scheduler drop its notice.
	it("a check while the countdown shows keeps the countdown the scheduler shows", async () => {
		background.work = SUBAGENTS;
		autoInstallOn = true;
		await tick();
		const countdown = { state: "downloaded", restartAt: expect.any(Number) };
		expect(mocks.sent.at(-1)).toMatchObject(countdown);
		await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		await tick();
		expect(mocks.sent.at(-1)).toMatchObject(countdown);
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
		expect(mocks.calls.some(call => call.method === "updater.check")).toBe(false);
	});
});

describe("Restart & install", () => {
	it("tells the window the update is installing before the install call", async () => {
		let heardWhenAsked: UpdateStatus | undefined;
		mocks.replies.set("updater.install", () => {
			heardWhenAsked = mocks.sent.at(-1);
			return installAnswer("quit-for-update");
		});
		await restartAndInstall();
		expect(heardWhenAsked).toMatchObject({ state: "downloaded", version: VERSION, installing: true });
	});

	it("passes how the windows sat, so the relaunch comes back the same way", async () => {
		mocks.windowVisible = false;
		await restartAndInstall();
		expect(installCalls().map(call => call.params)).toEqual([{ trigger: "user click", presence: "hidden" }]);
	});

	it("reads the presence the install marker holds, within the relaunch window", () => {
		fs.writeFileSync(
			path.join(mocks.userData.dir, "update-install.json"),
			JSON.stringify({
				from: "0.44.0",
				to: VERSION,
				mode: "nsis",
				trigger: "auto",
				at: Date.now(),
				presence: "hidden",
			}),
		);
		expect(updater.readRelaunchPresence()).toBe("hidden");
		fs.rmSync(path.join(mocks.userData.dir, "update-install.json"));
		expect(updater.readRelaunchPresence()).toBeNull();
	});

	it("starts nothing when clicked again while the install is under way", async () => {
		await restartAndInstall();
		await restartAndInstall();
		expect(installCalls()).toHaveLength(1);
		const installs = mocks.runtimeLog.filter(report => report.details.event === "install");
		expect(installs.map(report => report.details.trigger)).toEqual(["user click"]);
	});

	it("starts nothing for a click that lands while the first one still waits for the shell", async () => {
		await Promise.all([restartAndInstall(), restartAndInstall()]);
		expect(installCalls()).toHaveLength(1);
	});

	it("keeps saying 'installing' when Later is pressed after Now", async () => {
		autoInstallOn = true;
		await tick();
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", restartAt: expect.any(Number) });
		await restartAndInstall();
		await registry.invoke(IPC_COMMANDS.UPDATER_POSTPONE, caller, []);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
	});

	it("keeps saying 'installing' when the shell repeats the downloaded status, until another state arrives", async () => {
		await restartAndInstall();
		downloaded();
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
		emitStatus({ state: "idle" });
		downloaded();
		expect(mocks.sent.at(-1)).toEqual({ state: "downloaded", version: VERSION, mode: "automatic" });
	});

	it("an automatic install is not followed by a second countdown when the app stalls after it", async () => {
		autoInstallOn = true;
		await tick();
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await tick();
		expect(installCalls()).toHaveLength(1);
		// The 5.6 s the installer's start once froze the app for, then the tick that follows.
		vi.setSystemTime(countdown.restartAt + 5600);
		await tick();
		expect(schedulerEvents()).toEqual(["safe", "countdown", "install"]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
		expect(installCalls()).toHaveLength(1);
	});

	it("refuses with the installer-missing error when the shell has nothing staged", async () => {
		emitStatus({ state: "downloaded", version: VERSION, mode: "relaunch" }, "relaunch", false);
		await restartAndInstall();
		expect(installCalls()).toHaveLength(0);
		expect(mocks.sent.at(-1)).toEqual({
			state: "error",
			message: MAIN_TEXT["updates.installerMissing"].en,
			showInBanner: true,
		});
	});

	it("a manual copy asks the shell to reopen the installer: no confirm, no quit, no installing", async () => {
		background.work = SUBAGENTS;
		downloaded("manual");
		mocks.replies.set("updater.install", () => installAnswer("none"));
		await restartAndInstall();
		expect(installCalls().map(call => call.params)).toEqual([{ trigger: "user click" }]);
		expect(mocks.confirmUpdateRestart).not.toHaveBeenCalled();
		expect(mocks.order).toEqual([]);
		expect(mocks.sent.at(-1)).toEqual({ state: "downloaded", version: VERSION, mode: "manual" });
	});
});

describe("What the shell answers to the install", () => {
	it("`quit`: the relaunch is armed, Node runs the quit", async () => {
		downloaded("relaunch");
		mocks.replies.set("updater.install", () => installAnswer("quit"));
		await restartAndInstall();
		expect(mocks.order).toEqual(["requestQuit"]);
	});

	it("`quit-for-update`: the installer started, Node runs electron-updater's quit", async () => {
		await restartAndInstall();
		expect(mocks.order).toEqual(["before-quit-for-update", "app.quit"]);
	});

	it("`none`: nothing is staged, Node quits nothing and a later click may install", async () => {
		mocks.replies.set("updater.install", () => installAnswer("none"));
		await restartAndInstall();
		expect(mocks.order).toEqual([]);
		emitStatus({ state: "idle" });
		downloaded();
		mocks.replies.set("updater.install", () => installAnswer("quit-for-update"));
		await restartAndInstall();
		expect(mocks.order).toEqual(["before-quit-for-update", "app.quit"]);
	});

	it("a failed call turns the committed quit off and says so", async () => {
		mocks.replies.set("updater.install", () => {
			throw new Error("the shell is gone");
		});
		await restartAndInstall();
		expect(mocks.disarmed).toEqual(["update"]);
		expect(mocks.order).toEqual([]);
		expect(mocks.sent.at(-1)).toEqual({
			state: "error",
			message: MAIN_TEXT["updates.failed"].en,
			detail: "the shell is gone",
			showInBanner: true,
		});
		// The error is Node's own: the shell's answer to the next check shows its state again.
		mocks.replies.set("updater.check", () =>
			shellState({ state: "downloaded", version: VERSION, mode: "automatic" }),
		);
		mocks.replies.set("updater.install", () => installAnswer("quit-for-update"));
		await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		expect(mocks.sent.at(-1)).toEqual({ state: "downloaded", version: VERSION, mode: "automatic" });
		await restartAndInstall();
		expect(mocks.order).toEqual(["before-quit-for-update", "app.quit"]);
	});
});

describe("The automatic install and an open card", () => {
	// 12 Nov 2026: a card held the update from 06:12:58; the owner's click at 08:02:34 installed it, and one second later
	// the scheduler still logged `safe` and `countdown`.
	it("writes nothing and starts no countdown after an install a person started", async () => {
		autoInstallOn = true;
		holds.asking = true;
		await tick();
		await restartAndInstall();
		holds.asking = false;
		vi.setSystemTime(Date.now() + 1000);
		await tick();
		expect(schedulerEvents()).toEqual(["waiting:open ask", "install"]);
		expect(installCalls()).toHaveLength(1);
	});

	it("installs over a question nobody at the computer answered for ten minutes", async () => {
		autoInstallOn = true;
		holds.asking = true;
		mocks.idleSeconds = 60 * 60;
		await tick();
		vi.setSystemTime(Date.now() + 10 * 60 * 1000);
		await tick();
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		await tick();
		expect(schedulerEvents()).toEqual(["waiting:open ask", "unattended", "countdown", "install"]);
		expect(installCalls()).toHaveLength(1);
	});

	it("keeps waiting for a plan proposal however long nobody is there: the relaunch would lose it", async () => {
		autoInstallOn = true;
		holds.asking = true;
		holds.planWaiting = true;
		mocks.idleSeconds = 24 * 60 * 60;
		await tick();
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		await tick();
		expect(schedulerEvents()).toEqual(["waiting:open ask"]);
		expect(installCalls()).toHaveLength(0);
	});
});

describe("The mirror of the shell's state", () => {
	it("localizes an error's key and adds the shell's suffix", () => {
		emitStatus({ state: "error", key: "updates.checkFailed", suffix: "HTTP 502", detail: "raw", showInBanner: true });
		expect(updater.updateStatus()).toEqual({
			state: "error",
			message: `${MAIN_TEXT["updates.checkFailed"].en} (HTTP 502)`,
			detail: "raw",
			showInBanner: true,
		});
		emitStatus({ state: "error", key: "updates.noResult" });
		expect(mocks.sent.at(-1)).toEqual({ state: "error", message: MAIN_TEXT["updates.noResult"].en });
	});

	it("reads the install mode and what is restartable from the shell's state", () => {
		expect(updater.updateInstallMode()).toBe("automatic");
		expect(updater.restartableUpdate()).toBe(true);
		emitStatus({ state: "downloaded", version: VERSION, mode: "relaunch" }, "relaunch", false);
		expect(updater.updateInstallMode()).toBe("relaunch");
		expect(updater.restartableUpdate()).toBe(false);
		downloaded("manual");
		expect(updater.updateInstallMode()).toBe("manual");
		expect(updater.restartableUpdate()).toBe(false);
	});

	it("answers the install-mode channel once the shell's start answered", async () => {
		await boot({ "updater.start": () => shellState({ state: "idle" }, "relaunch") }, false);
		await expect(registry.invoke(IPC_COMMANDS.UPDATER_INSTALL_MODE, caller, [])).resolves.toBe("relaunch");
	});

	it("a check awaits the shell and shows its answer once, though the event came first", async () => {
		emitStatus({ state: "idle" });
		const found = shellState({ state: "available", version: VERSION, mode: "automatic" });
		mocks.replies.set("updater.check", () => {
			emit("status", found);
			return found;
		});
		mocks.sent.length = 0;
		const status = await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		expect(status).toMatchObject({ state: "available", version: VERSION });
		expect(mocks.sent).toHaveLength(1);
	});

	it("a failed check call reaches the banner", async () => {
		emitStatus({ state: "idle" });
		mocks.replies.set("updater.check", () => {
			throw new Error("boom");
		});
		await expect(registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, [])).resolves.toEqual({
			state: "error",
			message: MAIN_TEXT["updates.checkFailed"].en,
			detail: "boom",
			showInBanner: true,
		});
	});

	it("starts the download only for an available update", async () => {
		await registry.invoke(IPC_COMMANDS.UPDATER_DOWNLOAD, caller, []);
		expect(mocks.calls.some(call => call.method === "updater.download")).toBe(false);
		emitStatus({ state: "available", version: VERSION, mode: "automatic" });
		mocks.replies.set("updater.download", () =>
			shellState({ state: "downloading", version: VERSION, mode: "automatic", percent: 3 }),
		);
		await expect(registry.invoke(IPC_COMMANDS.UPDATER_DOWNLOAD, caller, [])).resolves.toMatchObject({
			state: "downloading",
		});
	});

	it("tells the status listeners what the windows heard", () => {
		const heard: UpdateStatus[] = [];
		const off = updater.onUpdateStatus(status => heard.push(status));
		emitStatus({ state: "checking" });
		off();
		emitStatus({ state: "idle" });
		expect(heard).toEqual([{ state: "checking" }]);
	});
});

describe("The shell's asks", () => {
	it("serves the login shell's token and PATH before it calls start", async () => {
		let servedAtStart: boolean | undefined;
		const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		try {
			mocks.loginEnv = { GITHUB_TOKEN: "from-login-shell" };
			await boot({
				"updater.start": () => {
					servedAtStart = mocks.handlers.has("updater.loginEnv");
					return shellState({ state: "idle" });
				},
			});
			expect(servedAtStart).toBe(true);
			const serve = mocks.handlers.get("updater.loginEnv");
			await expect(serve?.({})).resolves.toEqual({ token: "from-login-shell", path: "/login/bin:/usr/bin" });
			process.env.GH_TOKEN = "from-launch";
			await expect(serve?.({})).resolves.toEqual({ token: "from-launch", path: "/login/bin:/usr/bin" });
			delete process.env.GH_TOKEN;
			mocks.loginEnv = {};
			await expect(serve?.({})).resolves.toEqual({ path: "/login/bin:/usr/bin" });
		} finally {
			mocks.loginEnv = {};
			if (saved.gh !== undefined) process.env.GH_TOKEN = saved.gh;
			if (saved.github !== undefined) process.env.GITHUB_TOKEN = saved.github;
		}
	});

	it("starts the shell once with the app version and reports the last install once the first page loaded", async () => {
		fs.writeFileSync(
			path.join(mocks.userData.dir, "update-install.json"),
			JSON.stringify({ from: "0.43.0", to: "0.44.0", mode: "nsis", trigger: "auto", at: Date.now() - 1000 }),
		);
		await boot();
		// Setup reports nothing: the previous install is read once the first page has loaded.
		expect(mocks.runtimeLog.find(report => report.message === "swap")).toBeUndefined();
		updater.noteAppStarted();
		expect(mocks.calls.filter(call => call.method === "updater.start")).toEqual([
			{ method: "updater.start", params: { version: "0.44.0" } },
		]);
		const result = mocks.runtimeLog.find(report => report.message === "swap");
		expect(result?.details).toMatchObject({
			event: "result",
			outcome: "installed",
			previous: "0.43.0",
			mode: "nsis",
		});
		expect(fs.existsSync(path.join(mocks.userData.dir, "update-install.json"))).toBe(false);
	});
});

describe("The approved quit", () => {
	it("relaunch: tells the shell once, from `will-quit` or the forced exit, whichever comes first", () => {
		emitStatus({ state: "downloaded", version: VERSION, mode: "relaunch" }, "relaunch");
		for (const hook of mocks.willQuit) hook();
		for (const hook of mocks.forcedExit) hook();
		expect(mocks.posts).toEqual([{ name: "updater.quit", data: { trigger: "quit", presence: "behind" } }]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
	});

	it("relaunch: nothing to install, nothing to tell", () => {
		emitStatus({ state: "downloaded", version: VERSION, mode: "relaunch" }, "relaunch", false);
		for (const hook of mocks.willQuit) hook();
		for (const hook of mocks.forcedExit) hook();
		expect(mocks.posts).toEqual([]);
	});

	/** The app ends: `will-quit` for an approved quit, then `quit` with the code (a forced `exit(code)` emits only `quit`). */
	const end = (code: number, approved: boolean): void => {
		if (approved) for (const hook of mocks.willQuit) hook();
		for (const hook of mocks.quit) hook({}, code);
	};

	it("automatic: tells the shell when the app ends with code 0, an approved quit or a forced exit(0), and no install began", () => {
		end(0, true);
		expect(mocks.posts).toEqual([{ name: "updater.quit", data: { trigger: "quit", presence: "behind" } }]);
	});

	it("automatic: a forced exit(0) installs too, an exit with a failure code does not", () => {
		end(1, false);
		expect(mocks.posts).toEqual([]);
		end(0, false);
		expect(mocks.posts).toEqual([{ name: "updater.quit", data: { trigger: "quit", presence: "behind" } }]);
	});

	it("automatic: says nothing after an install the shell already started", async () => {
		await restartAndInstall();
		end(0, true);
		expect(mocks.posts).toEqual([]);
	});

	it("automatic: says nothing while no update is downloaded", () => {
		emitStatus({ state: "idle" });
		end(0, true);
		expect(mocks.posts).toEqual([]);
	});
});

describe("The token's calls", () => {
	it("pass through to the shell with the token as given", async () => {
		mocks.replies.set("updater.authTest", () => ({ access: "ok", source: "stored" }));
		await registry.invoke(IPC_COMMANDS.UPDATER_AUTH_TEST, caller, ["  ghp_x "]);
		await registry.invoke(IPC_COMMANDS.UPDATER_AUTH_TEST, caller, []);
		expect(mocks.calls.filter(call => call.method === "updater.authTest").map(call => call.params)).toEqual([
			{ token: "  ghp_x " },
			{},
		]);
	});

	it.each(["keychain_would_ask", "safe_storage_unavailable"])(
		"rethrows `%s` the way the window's IPC carries a code",
		async code => {
			mocks.replies.set("updater.authSave", () => {
				throw new hostErrorClass(code, "cannot store");
			});
			await expect(registry.invoke(IPC_COMMANDS.UPDATER_AUTH_SAVE, caller, ["ghp_x"])).rejects.toThrow(
				`[${code}] cannot store`,
			);
		},
	);

	it("leaves any other failure as it is", async () => {
		mocks.replies.set("updater.authClear", () => {
			throw new hostErrorClass("failed", "disk full");
		});
		await expect(registry.invoke(IPC_COMMANDS.UPDATER_AUTH_CLEAR, caller, [])).rejects.toThrow(/^disk full$/);
	});
});

// The macOS swap helper reopens the new app and waits for this mark before it drops the old one (updater-state.ts).
describe("the start mark and a start that failed", () => {
	const markFile = () => path.join(mocks.userData.dir, "app-started.json");
	const installFile = () => path.join(mocks.userData.dir, "update-install.json");
	const failedFile = () => path.join(mocks.userData.dir, "update-start-failed.json");
	const results = () => mocks.runtimeLog.filter(report => report.details.event === "result");

	it("is written once, with the running version, before the previous install is reported; a start failure is remembered", () => {
		// The helper rolled 0.45.0 back to this 0.44.0: its log's last outcome says the new app did not start.
		fs.writeFileSync(
			installFile(),
			JSON.stringify({ from: "0.44.0", to: "0.45.0", mode: "relaunch", trigger: "auto", at: Date.now() }),
		);
		fs.mkdirSync(path.join(mocks.userData.dir, "updates"), { recursive: true });
		fs.writeFileSync(
			path.join(mocks.userData.dir, "updates", "swap.log"),
			"swap Mon Oct 19 14:03:22 KST 2026: /s -> /d\ninstalled\nwaiting for the new app to start\nstart failed; previous app restored\n",
		);
		// Set up and running, no page yet: no mark, and the install marker is still unread (a new app that dies here
		// leaves it for the old app the helper restores).
		expect(fs.existsSync(markFile())).toBe(false);
		expect(fs.existsSync(installFile())).toBe(true);
		expect(results()).toEqual([]);
		expect(fs.existsSync(failedFile())).toBe(false);

		updater.noteAppStarted();
		expect(JSON.parse(fs.readFileSync(markFile(), "utf8"))).toEqual({
			version: "0.44.0",
			pid: process.pid,
			at: expect.any(Number),
		});
		expect(results()).toHaveLength(1);
		expect(results()[0]?.details).toMatchObject({
			outcome: "rolled back",
			previous: "0.44.0",
			expected: "0.45.0",
			current: "0.44.0",
			swapOutcome: "start failed; previous app restored",
		});
		expect(fs.existsSync(installFile())).toBe(false);
		expect(JSON.parse(fs.readFileSync(failedFile(), "utf8"))).toEqual({
			version: "0.45.0",
			count: 1,
			at: expect.any(Number),
		});

		// A second page (another window, a reload) writes nothing more.
		fs.rmSync(markFile());
		updater.noteAppStarted();
		expect(fs.existsSync(markFile())).toBe(false);
		expect(results()).toHaveLength(1);
	});

	it("leaves that version to the person: the automatic install skips it once, a click installs it, a newer one clears it", async () => {
		// 0.45.0, the version downloaded here, failed to start earlier; the record is read at setup.
		fs.writeFileSync(failedFile(), JSON.stringify({ version: VERSION, count: 1, at: Date.now() }));
		await boot();
		autoInstallOn = true;
		await tick();
		await tick();
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		await tick();
		expect(schedulerEvents()).toEqual(["withdrawn:start failed before"]);
		expect(installCalls()).toHaveLength(0);

		await restartAndInstall();
		expect(installCalls().map(call => call.params)).toEqual([{ trigger: "user click", presence: "behind" }]);
		await tick();

		mocks.runtimeLog.length = 0;
		emitStatus({ state: "downloaded", version: "0.46.0", mode: "automatic" });
		await tick();
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
		expect(fs.existsSync(failedFile())).toBe(false);
	});

	it("a check looks past the held version: the shell is asked, and a failed call keeps the download", async () => {
		fs.writeFileSync(failedFile(), JSON.stringify({ version: VERSION, count: 1, at: Date.now() }));
		await boot();
		const checks = () => mocks.calls.filter(call => call.method === "updater.check");
		mocks.replies.set("updater.check", () => {
			throw new Error("offline");
		});
		await expect(registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, [])).resolves.toMatchObject({
			state: "downloaded",
			version: VERSION,
		});
		expect(checks()).toHaveLength(1);

		// Any other downloaded version is the answer by itself, as before: the shell is not asked.
		emitStatus({ state: "downloaded", version: "0.46.0", mode: "automatic" });
		await registry.invoke(IPC_COMMANDS.UPDATER_CHECK, caller, []);
		expect(checks()).toHaveLength(1);
	});
});
