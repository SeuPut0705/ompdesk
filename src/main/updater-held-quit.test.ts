/**
 * macOS relaunch mode: a version whose start failed (`update-start-failed.json`) is never installed by an ordinary quit
 * or the quit watchdog's forced exit (the helper would run with no relaunch, remove the previous app at once and check
 * nothing); only "Restart & install" installs it, with the start check. Any other staged version installs at a quit as
 * before (updater.ts `launchStagedSwap`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MAIN_TEXT from "../../native/ompdesk/crates/shell/src/boot_core/main-text.json";
import { NO_BACKGROUND_WORK } from "./background-work";
import type { MainTextKey } from "./shell-host/modules/boot";
import { IpcRegistry } from "./web/ipc-registry";

const mocks = vi.hoisted(() => ({
	userData: { dir: "" },
	appEvents: new Map<string, Array<() => void>>(),
	forcedExit: [] as Array<() => void>,
	spawned: [] as string[][],
	runtimeLog: [] as Array<{ message: string; details: Record<string, unknown> }>,
	updater: {
		on: () => {},
		setFeedURL: () => {},
		autoInstallOnAppQuit: false,
		autoDownload: false,
	},
}));

vi.mock("node:child_process", async importOriginal => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (_command: string, args: string[]) => {
		mocks.spawned.push(args.slice(3));
		return { unref: () => {} };
	},
}));
vi.mock("electron", () => ({
	app: {
		isPackaged: false,
		getVersion: () => "0.44.0",
		getPath: () => mocks.userData.dir,
		on: (event: string, listener: () => void) => {
			mocks.appEvents.set(event, [...(mocks.appEvents.get(event) ?? []), listener]);
		},
	},
	BrowserWindow: { getAllWindows: () => [] },
	net: {},
	powerMonitor: { getSystemIdleTime: () => 0 },
	shell: {},
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.updater } }));
vi.mock("./nsis-updater", () => ({ OmpNsisUpdater: class {} }));
vi.mock("./app-quit", () => ({
	confirmUpdateRestart: async () => true,
	disarmQuitWatchdog: () => {},
	onQuitForcedExit: (listener: () => void) => mocks.forcedExit.push(listener),
	requestQuit: () => {},
}));
vi.mock("./hang-watchdog", () => ({ markMainStep: () => {} }));
vi.mock("./shell-host/modules/boot", () => ({ mainT: (key: MainTextKey) => MAIN_TEXT[key].en }));
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

const realPlatform = process.platform;
const env = { ...process.env };

/** A launch on a stand-in bundle with `staged` staged; `failed` is the version recorded as failed to start (or none). */
async function launch(staged: string, failed?: string) {
	vi.resetModules();
	mocks.appEvents.clear();
	mocks.forcedExit.length = 0;
	mocks.spawned.length = 0;
	mocks.runtimeLog.length = 0;
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-held-"));
	const bundle = path.join(mocks.userData.dir, "apps", "Stand-in.app");
	const stagedBundle = path.join(mocks.userData.dir, "updates", staged, "Stand-in.app");
	fs.mkdirSync(bundle, { recursive: true });
	fs.mkdirSync(stagedBundle, { recursive: true });
	if (failed) {
		fs.writeFileSync(
			path.join(mocks.userData.dir, "update-start-failed.json"),
			JSON.stringify({ version: failed, count: 1, at: 1 }),
		);
	}
	Object.defineProperty(process, "platform", { value: "darwin" });
	process.env.OMP_DEV_UPDATE_MODE = "relaunch";
	process.env.OMP_DEV_UPDATE_BUNDLE = bundle;
	process.env.OMP_DEV_UPDATE_STAGED = stagedBundle;
	process.env.OMP_DEV_UPDATE_STAGED_VERSION = staged;
	const { setupUpdater, applyUpdate } = await import("./updater");
	const registry = new IpcRegistry({ handle: () => {}, on: () => {} });
	setupUpdater(registry, {
		enabled: () => false,
		resumes: () => true,
		busy: () => false,
		asking: () => false,
		planWaiting: () => false,
		compacting: () => false,
		backgroundWork: async () => NO_BACKGROUND_WORK,
	});
	const quit = () => {
		for (const listener of mocks.appEvents.get("will-quit") ?? []) listener();
	};
	return { bundle, stagedBundle, applyUpdate, quit };
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform });
	process.env = { ...env };
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
	return () => vi.useRealTimers();
});

describe("a quit with a staged version that failed to start before", () => {
	it("starts no swap at an ordinary quit, and says so", async () => {
		const { quit } = await launch("0.45.0", "0.45.0");
		quit();
		expect(mocks.spawned).toEqual([]);
		const skipped = mocks.runtimeLog.find(report => report.details.event === "skipped");
		expect(skipped?.details).toMatchObject({ reason: "start failed before", version: "0.45.0" });
		expect(fs.existsSync(path.join(mocks.userData.dir, "update-install.json"))).toBe(false);
	});

	it("starts no swap at the quit watchdog's forced exit either", async () => {
		await launch("0.45.0", "0.45.0");
		for (const listener of mocks.forcedExit) listener();
		expect(mocks.spawned).toEqual([]);
	});

	it("still installs it, with the start check, when a person pressed Restart & install", async () => {
		const { bundle, stagedBundle, applyUpdate, quit } = await launch("0.45.0", "0.45.0");
		await applyUpdate();
		quit();
		expect(mocks.spawned).toHaveLength(1);
		const [, src, dest, relaunch, , mark, version] = mocks.spawned[0] ?? [];
		expect([src, dest, relaunch, version]).toEqual([stagedBundle, bundle, "1", "0.45.0"]);
		expect(mark).toBe(path.join(mocks.userData.dir, "app-started.json"));
	});

	it("installs another staged version at a quit as before", async () => {
		const { quit } = await launch("0.46.0", "0.45.0");
		quit();
		expect(mocks.spawned).toHaveLength(1);
		expect(mocks.spawned[0]?.[3]).toBe("0");
	});
});
