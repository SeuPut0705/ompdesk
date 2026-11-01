/**
 * "Restart & install" on Windows (updater.ts). Installing blocks the app for seconds (the installer starts and the
 * app quits), so the window must hear about it first, and a second click while it runs must start nothing: the
 * user clicked twice, 5 s apart, because nothing on screen said the first one had worked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS, type UpdateStatus } from "../shared/ipc-types";
import { type BackgroundWork, type BackgroundWorkSource, NO_BACKGROUND_WORK } from "./background-work";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { appAutoUpdatePrefChanged, readRelaunchPresence, setupUpdater } from "./updater";
import { type IpcCaller, IpcRegistry } from "./web/ipc-registry";

const mocks = vi.hoisted(() => {
	const updaterEvents = new Map<string, Array<(...args: unknown[]) => void>>();
	const asked: unknown[] = [];
	const answer = { go: true };
	return {
		updaterEvents,
		// The one updater both electron-updater's `autoUpdater` (macOS) and OmpNsisUpdater (Windows) stand for.
		updater: {
			on: (event: string, listener: (...args: unknown[]) => void) => {
				updaterEvents.set(event, [...(updaterEvents.get(event) ?? []), listener]);
			},
			setFeedURL: () => {},
			quitAndInstall: vi.fn(),
		},
		sent: [] as UpdateStatus[],
		runtimeLog: [] as Array<{ message: string; details: Record<string, unknown> }>,
		userData: { dir: "" },
		windowVisible: true,
		/** What the restart confirm is told: it reads the work like the real one, then answers `answer.go`. */
		confirmUpdateRestart: vi.fn(async (readWork: () => Promise<unknown>) => {
			asked.push(await readWork());
			return answer.go;
		}),
		asked,
		answer,
	};
});

vi.mock("electron", () => ({
	app: {
		isPackaged: true,
		getVersion: () => "0.44.0",
		getPath: () => mocks.userData.dir,
		on: () => {},
	},
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
	net: {},
	powerMonitor: { getSystemIdleTime: () => 0 },
	shell: {},
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.updater } }));
vi.mock("./nsis-updater", () => ({
	OmpNsisUpdater: class {
		on = mocks.updater.on;
		setFeedURL = mocks.updater.setFeedURL;
		quitAndInstall = mocks.updater.quitAndInstall;
	},
}));
vi.mock("./app-quit", () => ({
	confirmUpdateRestart: mocks.confirmUpdateRestart,
	disarmQuitWatchdog: () => {},
	onQuitForcedExit: () => {},
	requestQuit: () => {},
}));
vi.mock("./hang-watchdog", () => ({ markMainStep: () => {} }));
vi.mock("./i18n", () => ({
	mainT: (key: MainTextKey) => MAIN_TEXT[key].en,
}));
vi.mock("./runtime-log", () => ({
	writeRuntimeLog: (report: { message: string; details: Record<string, unknown> }) => mocks.runtimeLog.push(report),
}));
vi.mock("./update-auth", () => ({
	GITHUB_API_REPO: "https://api.github.com/repos/example/example",
	checkRepoAccess: async () => "ok",
	clearUpdateToken: async () => {},
	resolveUpdateToken: async () => undefined,
	storeUpdateToken: async () => {},
	updateAuthInfo: async () => ({}),
}));
vi.mock("./update-provider", () => ({ releaseUpdateProvider: () => ({}) }));

const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
const registry = new IpcRegistry({ handle: () => {}, on: () => {} });
const realPlatform = process.platform;
let autoInstallOn = false;
/** What the background-work probe answers: the cached reading the scheduler reads, and what a click asks fresh. */
const background = { work: NO_BACKGROUND_WORK as BackgroundWork, pending: false };
const source: BackgroundWorkSource = {
	read: () => ({ ...background }),
	idle: () => {},
	fresh: async () => background.work,
};

function emitUpdater(event: string, ...args: unknown[]): void {
	for (const listener of mocks.updaterEvents.get(event) ?? []) listener(...args);
}

function restartAndInstall(): Promise<unknown> {
	return registry.invoke(IPC_COMMANDS.UPDATER_APPLY, caller, []);
}

beforeAll(() => {
	// The scheduler reads `Date.now` once, at setup: the fake clock has to be in place by then.
	vi.useFakeTimers({ toFake: ["Date"] });
	// Windows' install path (NSIS, `automatic`) on any host that runs the suite.
	Object.defineProperty(process, "platform", { value: "win32" });
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-install-"));
	setupUpdater(registry, {
		enabled: () => autoInstallOn,
		resumes: () => true,
		busy: () => false,
		asking: () => false,
		compacting: () => false,
		backgroundWork: source,
	});
});

afterAll(() => {
	vi.useRealTimers();
	Object.defineProperty(process, "platform", { value: realPlatform });
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

afterEach(() => {
	autoInstallOn = false;
	appAutoUpdatePrefChanged();
});

beforeEach(() => {
	mocks.sent.length = 0;
	mocks.runtimeLog.length = 0;
	mocks.updater.quitAndInstall.mockReset();
	emitUpdater("update-downloaded", { version: "0.45.0", files: [{ size: 113_241_490 }] });
	background.work = NO_BACKGROUND_WORK;
	background.pending = false;
	mocks.answer.go = true;
	mocks.asked.length = 0;
	mocks.confirmUpdateRestart.mockClear();
});

const SUBAGENTS: BackgroundWork = {
	subagents: 2,
	jobs: 0,
	subagentLabels: ["LayoutSplit", "StreamFast"],
	jobLabels: [],
};
const schedulerEvents = () =>
	mocks.runtimeLog.flatMap(report =>
		report.message === "scheduler"
			? [`${report.details.event}${report.details.reason ? `:${report.details.reason}` : ""}`]
			: [],
	);

describe("Restart & install with background work running", () => {
	it("asks with a fresh reading of the work and starts nothing when cancelled", async () => {
		background.work = SUBAGENTS;
		mocks.answer.go = false;
		await restartAndInstall();
		expect(mocks.asked).toEqual([SUBAGENTS]);
		expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
		mocks.answer.go = true;
		await restartAndInstall();
		expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
	});

	it("the automatic install waits for it, never asks, and installs once it ends", () => {
		background.work = SUBAGENTS;
		autoInstallOn = true;
		appAutoUpdatePrefChanged();
		appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["waiting:background work"]);
		expect(mocks.sent.at(-1)).not.toHaveProperty("restartAt");
		background.work = NO_BACKGROUND_WORK;
		appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["waiting:background work", "safe", "countdown"]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", restartAt: expect.any(Number) });
		expect(mocks.confirmUpdateRestart).not.toHaveBeenCalled();
	});

	it("decides nothing until the probe has answered once", () => {
		background.pending = true;
		autoInstallOn = true;
		appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual([]);
		background.pending = false;
		appAutoUpdatePrefChanged();
		expect(schedulerEvents()).toEqual(["safe", "countdown"]);
	});
});

describe("Restart & install on Windows", () => {
	it("tells the window the update is installing before the installer starts", async () => {
		let heardWhenInstallerStarted: UpdateStatus | undefined;
		mocks.updater.quitAndInstall.mockImplementation(() => {
			heardWhenInstallerStarted = mocks.sent.at(-1);
		});
		await restartAndInstall();
		expect(heardWhenInstallerStarted).toMatchObject({ state: "downloaded", version: "0.45.0", installing: true });
	});

	it("records how the windows sat, so the relaunch comes back the same way", async () => {
		mocks.windowVisible = false;
		try {
			await restartAndInstall();
		} finally {
			mocks.windowVisible = true;
		}
		const helper = mocks.runtimeLog.find(report => report.details.event === "helper");
		expect(helper?.details).toMatchObject({ mode: "nsis", presence: "hidden" });
		expect(readRelaunchPresence()).toBe("hidden");
	});

	it("starts nothing when clicked again while the install is under way", async () => {
		await restartAndInstall();
		await restartAndInstall();
		expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
		const installs = mocks.runtimeLog.filter(report => report.details.event === "install");
		expect(installs.map(report => report.details.trigger)).toEqual(["user click"]);
	});

	it("keeps saying 'installing' when Later is pressed after Now", async () => {
		autoInstallOn = true;
		appAutoUpdatePrefChanged();
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", restartAt: expect.any(Number) });
		await restartAndInstall();
		await registry.invoke(IPC_COMMANDS.UPDATER_POSTPONE, caller, []);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
	});

	it("an automatic install is not followed by a second countdown when the app stalls after it", () => {
		autoInstallOn = true;
		appAutoUpdatePrefChanged();
		const countdown = mocks.sent.at(-1);
		if (countdown?.state !== "downloaded" || countdown.restartAt === undefined) throw new Error("no countdown");
		vi.setSystemTime(countdown.restartAt);
		appAutoUpdatePrefChanged();
		expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
		// The 5.6 s the installer's start once froze the app for, then the tick that follows.
		vi.setSystemTime(countdown.restartAt + 5600);
		appAutoUpdatePrefChanged();
		const logged = mocks.runtimeLog.flatMap(report => (report.message === "scheduler" ? [report.details.event] : []));
		expect(logged).toEqual(["safe", "countdown", "install"]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
		expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
	});
});
