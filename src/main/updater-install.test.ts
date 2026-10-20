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
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { appAutoUpdatePrefChanged, setupUpdater } from "./updater";
import { type IpcCaller, IpcRegistry } from "./web/ipc-registry";

const mocks = vi.hoisted(() => {
	const updaterEvents = new Map<string, Array<(...args: unknown[]) => void>>();
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
	confirmQuit: async () => true,
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
		expect(logged).toEqual(["quiet", "countdown", "install"]);
		expect(mocks.sent.at(-1)).toMatchObject({ state: "downloaded", installing: true });
		expect(mocks.updater.quitAndInstall).toHaveBeenCalledTimes(1);
	});
});
