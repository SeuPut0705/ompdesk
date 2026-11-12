/**
 * Every way a session's omp starts launches the same omp: the same extensions (bridge, control tools' skill, REA,
 * pstack, ECC, formal, ai-memory), the same OMPdesk settings (reply language, profile, suggestions, titles, judge,
 * delegation, account rotation, model roles, memory recall), the same proxy and environment. The paths: a new tab,
 * a stored session opened, a relaunch's saved tab started later, a relaunch's interrupted turn, an omp update's
 * restart, a paired device's tab on this computer and that tab revived after this computer relaunched.
 *
 * What may differ, and why:
 * - how the spawn opens its session (`--session <file>`, `--config fresh-launch.yml` or neither): that is the path;
 * - `OMP_GUI_BRIDGE`: each omp process gets its own bridge socket;
 * - `OMP_GUI_PROMPT_ORIGIN`: a paired device's tab journals its prompts as that device's (prompt-origin.ts).
 *
 * The omp is a real process now: the core's lane spawns it (`native/ompdesk/crates/core/src/sidecar`), so the case's stand-in
 * is a fake omp script that records how it was started (argv, environment, the session it is on) and answers `get_state`
 * like stock. The cases reached into the TypeScript spawn before (a mocked `node:child_process` with in-memory children
 * and a fake clock for the restart delay): they read the records, kill the process for a crash, and the lanes' restart
 * delays are shortened by `tuning`.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OmpRuntimeModule from "./omp-runtime";
import type * as ShellEnvModule from "./shell-env";
import type { SidecarManager } from "./sidecar";

const spawned = vi.hoisted(() => ({ bin: "", ompInstalled: true }));
vi.mock("electron", () => ({
	app: {
		getPreferredSystemLanguages: () => ["ko-KR"],
		getLocale: () => "ko",
		getPath: () => tmpdir(),
		getVersion: () => "0.0.0-test",
	},
}));
vi.mock("./i18n", () => ({ ompFailureText: (reason: string) => reason, mainT: (key: string) => key }));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: () => {} }));
vi.mock("./shell-env", async importOriginal => ({
	...(await importOriginal<typeof ShellEnvModule>()),
	shellSpawnEnv: async () => ({ SHELL_ONLY: "from-login-shell" }),
}));
vi.mock("./omp-runtime", async importOriginal => ({
	...(await importOriginal<typeof OmpRuntimeModule>()),
	systemOmp: async () =>
		spawned.ompInstalled
			? {
					ok: true,
					runtime: {
						bin: spawned.bin,
						version: "18.13.3",
						run: async () => ({ code: 0, stdout: "", stderr: "" }),
					},
				}
			: { ok: false, error: "omp is not installed" },
}));
vi.mock("./builtin-mcp", () => ({
	builtinReaState: async () => ({ enabled: true, available: true, nodeVersion: "v24.0.0" }),
	spawnReaState: async () => ({ enabled: true, available: true, nodeVersion: "v24.0.0" }),
}));

import { BridgeHealth } from "./bridge-health";
import { initDeletedSessions } from "./deleted-sessions";
import type { MachineServices } from "./machine-services";
import type { HostConnection } from "./remote/host-server";
import { LocalHostServices } from "./remote/host-services";
import type { PeerInfo } from "./remote/peers-store";
import { SessionKindStore } from "./session-kinds";
import { type LocalSidecarFactory, localSidecarFactory } from "./sidecar-factory";
import { SidecarPool } from "./sidecar-pool";
import { TAB_LAYOUT_VERSION } from "./tab-layout";
import { writeFakeOmp } from "./test-fake-omp";
import type { ClientWindow } from "./web/client-window";

/**
 * The omp the lane spawns: answers `ready`, then `get_state` with the session it is on (its `--session`, else a new
 * one), and moves to another session on `switch_session` / `new_session` (stock's responses name no file). It keeps a
 * record of how it was started and the session it is on in `$LAUNCH_PARITY_DIR/omps/<pid>.json`, and reads what the
 * case wants from `$LAUNCH_PARITY_DIR/mode.json` (`writesNewSession`, `answersState`) at each use.
 */
const FAKE_OMP = `
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
const dir = process.env.LAUNCH_PARITY_DIR ?? "";
const mode = () => JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8"));
const args = process.argv.slice(2);
const at = args.indexOf("--session");
const created = path.join(dir, "new-" + process.pid + ".jsonl");
const write = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
let session = at >= 0 ? (args[at + 1] ?? created) : created;
// A new session's file: stock writes it at the first answer, which a tab that worked has had.
if (at < 0 && mode().writesNewSession) fs.writeFileSync(created, JSON.stringify({ type: "session", id: "new" }) + "\\n");
fs.mkdirSync(path.join(dir, "omps"), { recursive: true });
const record = () => fs.writeFileSync(path.join(dir, "omps", process.pid + ".json"), JSON.stringify({ args, env: process.env, pid: process.pid, ppid: process.ppid, session, at: Date.now() }));
record();
createInterface({ input: process.stdin }).on("line", line => {
	const frame = JSON.parse(line);
	if (frame.type === "switch_session" || frame.type === "new_session") {
		session = frame.sessionPath ?? path.join(dir, "in-omp-" + process.pid + "-" + Date.now() + ".jsonl");
		if (!frame.sessionPath) fs.writeFileSync(session, JSON.stringify({ type: "session", id: "in-omp" }) + "\\n");
		record();
		write({ type: "response", id: frame.id, command: frame.type, success: true, data: { cancelled: false } });
		return;
	}
	if (frame.type !== "get_state" || !mode().answersState) return;
	write({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: session, sessionFile: session } });
});
// Stock disposes its session and exits when its stdin ends: how a stop ends an omp on Windows (no signals).
process.stdin.on("end", () => process.exit(0));
write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
`;

/** One spawned omp, as its record says: how it was started and the session it is on now. */
interface FakeOmp {
	args: string[];
	env: Record<string, string>;
	pid: number;
	/** The process that started it: on Windows the `.cmd` shell the lane ran, whose pid the manager reports. */
	ppid: number;
	session: string;
	at: number;
	/** A crash: the process ends without its stdin's end. */
	exit(code: number): void;
}

let dir: string;
/** Every omp started so far, oldest first; `settle()` refreshes it from the records. */
let omps: FakeOmp[];
/** The managers the factory made, so `settle()` can tell when none is still on its way somewhere. */
let made: SidecarManager[];
const mode = { writesNewSession: true, answersState: true };

function writeMode(): void {
	writeFileSync(join(dir, "mode.json"), JSON.stringify(mode));
}

function readOmps(): FakeOmp[] {
	const folder = join(dir, "omps");
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.flatMap(name => {
			try {
				const record = JSON.parse(readFileSync(join(folder, name), "utf8")) as Omit<FakeOmp, "exit">;
				return [{ ...record, exit: () => void process.kill(record.pid) }];
			} catch {
				// Being written.
				return [];
			}
		})
		.sort((a, b) => a.at - b.at || a.pid - b.pid);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "launch-parity-"));
	omps = [];
	made = [];
	initDeletedSessions(null);
	spawned.ompInstalled = true;
	mode.writesNewSession = true;
	mode.answersState = true;
	writeMode();
	process.env.LAUNCH_PARITY_DIR = dir;
	spawned.bin = await writeFakeOmp(dir, FAKE_OMP);
});

afterEach(async () => {
	for (const sidecar of made) sidecar.dispose();
	await Promise.all(made.map(sidecar => sidecar.whenExited()));
	delete process.env.LAUNCH_PARITY_DIR;
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** The factory index.ts builds, with every switch on and a value for every setting. */
function factory(): LocalSidecarFactory {
	const create = localSidecarFactory({
		// The lanes' crash ladder, shortened: a restart comes within a tenth of a second.
		tuning: { restartDelaysMs: [100, 100, 100] },
		bridgeDir: "/bridge",
		builtinDir: "/builtin",
		builtinReaPref: () => true,
		// The folder rides along as OMP_GUI_MCP_CWD; the start paths here spell the same temp folder two ways
		// (/var vs /private/var), so the stand-in leaves it out.
		mcpHubEnv: async () => ({ OMP_GUI_MCP_HUB: "http://127.0.0.1:4100", OMP_GUI_MCP_AUTH: "Bearer launch-secret" }),
		reaRuntimeFile: "/ud/rea-runtime.json",
		agentControlPref: () => true,
		pstackPref: () => true,
		eccPref: () => true,
		proxyEnv: async () => ({ HTTPS_PROXY: "http://proxy.test:8080" }),
		bridgeHealth: new BridgeHealth(() => {}),
		sessionKinds: new SessionKindStore(join(tmpdir(), "launch-parity-kinds.json")),
		replyLanguagePref: () => undefined,
		userProfilePref: () => ({ name: "Seu", experience: "expert" }),
		nextPromptPrefs: () => ({ suggestions: true, inline: false }),
		autoTitlePrefs: () => ({ enabled: true, evolve: false, suppressed: false }),
		judgeAssistPref: () => true,
		delegationPref: () => "swarm",
		accountRotationPref: () => "even",
		accountRotationLedger: "/ud/rotation.json",
		creditSpendPref: () => true,
		ompdeskRolesFile: "/ud/roles.json",
		launchProfilesPref: () => ({}),
		aiMemoryExtensionArgs: async () => ["-e", "/ud/ai-memory/omp-ext"],
		memoryStateFile: "/ud/memory-recall.json",
	});
	return (...args) => {
		const sidecar = create(...args);
		made.push(sidecar);
		return sidecar;
	};
}

function fakeWindow(id: number): ClientWindow {
	return {
		webContents: { id, send: () => {} },
		isDestroyed: () => false,
		once: () => {},
		removeListener: () => {},
	} as unknown as ClientWindow;
}

function storedSession(name: string): string {
	const file = join(dir, name);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: name })}\n`);
	return file;
}

/**
 * Lets every start's resolution, its spawn, `ready` and the ready status's `get_state` land: returns once every manager
 * is at rest (read `ready`, `error`, `exited`, `waiting` or `asleep`, or waits for the `get_state` a stand-in does not
 * answer, with its omp up and its record written). The records are files the stand-ins write, so they are polled.
 */
async function settle(): Promise<void> {
	await vi.waitFor(
		() => {
			omps = readOmps();
			for (const sidecar of made) {
				const { status } = sidecar;
				if ((status === "starting" || status === "restarting") && sidecar.processAlive && !mode.answersState) {
					// On Windows the stand-in runs behind a `.cmd` shell: the manager's pid is its parent's.
					if (!omps.some(omp => omp.pid === sidecar.pid || omp.ppid === sidecar.pid))
						throw new Error("no record yet");
				} else if (status === "starting" || status === "restarting") {
					throw new Error(`a tab is ${status}`);
				}
			}
		},
		{ timeout: 15_000, interval: 25 },
	);
}

/** The omp ends without its stdin's end, as a crash does; resolves once its tab has learned of the exit and read it as one. */
async function crash(omp: FakeOmp | undefined): Promise<void> {
	if (!omp) return;
	const owner = made.find(sidecar => sidecar.processAlive && (sidecar.pid === omp.pid || sidecar.pid === omp.ppid));
	omp.exit(1);
	await vi.waitFor(
		() => {
			if (owner?.processAlive || owner?.status === "ready")
				throw new Error("the tab still reads the omp as running");
		},
		{ timeout: 15_000, interval: 25 },
	);
}

type Open = { session: string } | "new" | "default";

/** How a launch opens its session, and the rest of it with what may differ per process taken out. */
function launchOf(omp: FakeOmp): {
	open: Open;
	args: string[];
	env: Record<string, string>;
	origin?: string;
	controlOff?: string;
} {
	const args = [...omp.args];
	let open: Open = "default";
	const session = args.indexOf("--session");
	if (session >= 0) open = { session: args.splice(session, 2)[1] ?? "" };
	const config = args.indexOf("--config");
	if (config >= 0 && args[config + 1]?.endsWith("fresh-launch.yml")) {
		args.splice(config, 2);
		open = "new";
	}
	const { OMP_GUI_BRIDGE: _bridge, OMP_GUI_PROMPT_ORIGIN: origin, OMPDESK_CONTROL_OFF: controlOff, ...env } = omp.env;
	return { open, args, env, ...(origin ? { origin } : {}), ...(controlOff ? { controlOff } : {}) };
}

function peer(deviceId: string): PeerInfo {
	return { deviceId, name: `Phone ${deviceId}`, staticPub: "pub", nodeId: `n-${deviceId}`, login: null, pairedAt: 0 };
}

function connection(of: PeerInfo): HostConnection {
	return { peer: of, emit: () => {}, close: () => {} } as unknown as HostConnection;
}

function hostServices(pool: SidecarPool, create: LocalSidecarFactory): LocalHostServices {
	return new LocalHostServices({
		createSidecar: (cwd, kind, fresh, origin) => create(cwd, kind, fresh, origin),
		hostName: () => "Desk",
		sessionIndex: {
			list: async () => [],
			relist: () => {},
			searchContent: async () => [],
			kindFor: async () => "agent",
			recordedCwd: async () => dir,
			deleteSession: async () => {},
			moveSession: async (path: string) => path,
			sessionsDir: join(dir, "sessions"),
			readMessages: async () => [],
		},
		renameStoredSession: async () => {},
		defaultWorkspace: () => dir,
		launchProfiles: { get: () => undefined, set: () => {} },
		machine: {} as unknown as MachineServices,
		localTabs: pool,
		trashItem: async () => {},
	});
}

describe("a session's omp launches the same way on every start path", () => {
	it("this computer's tabs: new, stored, relaunch restore, interrupted turn, omp update", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const win = fakeWindow(1);
		const expected: Open[] = [];

		// A new tab (tab-spawn.ts, a new window).
		pool.acquire(dir, win, "new-tab", undefined, "agent", undefined, true);
		await settle();
		expected.push("new");

		// A stored session opened from the sidebar.
		const stored = storedSession("stored.jsonl");
		pool.acquire(dir, win, "stored-tab", stored);
		await settle();
		expected.push({ session: stored });

		// A relaunch: the saved layout's tabs come back deferred and start when shown or resumed.
		const relaunched = fakeWindow(2);
		const saved = storedSession("saved.jsonl");
		pool.restoreLayout(relaunched, {
			version: TAB_LAYOUT_VERSION,
			tabs: [
				{ cwd: dir, kind: "agent", sessionPath: saved },
				{ cwd: dir, kind: "agent" },
			],
			activeIndex: 0,
		});
		// One at a time: the lanes spawn concurrently, so what the spawn order tells is the order they were started in.
		for (const tab of pool.tabsForWindow(relaunched)) {
			pool.startTab(tab.tabId);
			await settle();
		}
		expected.push({ session: saved }, "new");

		// A relaunch's interrupted turn on a session no saved tab holds (index.ts `openTab`).
		const marked = storedSession("marked.jsonl");
		pool.acquire(dir, win, undefined, marked, "agent");
		await settle();
		expected.push({ session: marked });

		// An omp update restarts every idle tab on the session it is on.
		const before = omps.length;
		pool.restartOnNewOmp();
		await settle();
		expected.push(...omps.slice(0, before).map(omp => ({ session: omp.session })));

		const launches = omps.map(launchOf);
		expectOpens(
			launches.map(launch => launch.open),
			expected,
			before,
		);
		const [first, ...rest] = launches;
		for (const launch of rest) {
			expect(launch.args).toEqual(first?.args);
			expect(launch.env).toEqual(first?.env);
			expect(launch.origin).toBeUndefined();
		}
		// The bundle itself: every extension and every setting is in it.
		expect(first?.args).toEqual([
			"--mode",
			"rpc-ui",
			"-e",
			join("/bridge", "index.ts"),
			"-e",
			"/builtin",
			"-e",
			join("/builtin", "rea"),
			"-e",
			join("/builtin", "pstack"),
			"-e",
			join("/builtin", "ecc"),
			"-e",
			join("/builtin", "formal"),
			"-e",
			"/ud/ai-memory/omp-ext",
		]);
		expect(first?.env).toMatchObject({
			OMP_GUI_REPLY_LANGUAGE: "Korean",
			OMP_GUI_USER_PROFILE: JSON.stringify({ name: "Seu", experience: "expert" }),
			OMP_GUI_NEXT_PROMPT: JSON.stringify({ suggestions: true, inline: false }),
			OMP_GUI_JUDGE_ASSIST: "1",
			OMP_GUI_DELEGATION: "swarm",
			OMP_GUI_ACCOUNT_ROTATION: "even",
			OMP_GUI_ACCOUNT_ROTATION_STATE: "/ud/rotation.json",
			OMP_GUI_CREDIT_SPEND: "1",
			OMP_GUI_OMPDESK_ROLES: "/ud/roles.json",
			OMP_GUI_REA_ROOT: join("/builtin", "rea"),
			OMP_GUI_MCP_HUB: "http://127.0.0.1:4100",
			OMP_GUI_MCP_AUTH: "Bearer launch-secret",
			OMP_GUI_PSTACK: "1",
			OMP_GUI_ECC: "1",
			OMP_GUI_MEMORY: "/ud/memory-recall.json",
			HTTPS_PROXY: "http://proxy.test:8080",
			SHELL_ONLY: "from-login-shell",
		});
	});

	it("a paired device's tabs here launch as this computer's own, journaling the device's prompts", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		pool.acquire(dir, fakeWindow(1), "own", undefined, "agent", undefined, true);
		await settle();
		const services = hostServices(pool, create);
		const phone = peer("phone");
		const conn = connection(phone);
		const expected: Open[] = ["new"];

		// The device opens a new tab, then a stored session.
		await services.call(phone, "tab.open", { rtab: "t1", cwd: dir, fresh: true }, conn);
		await services.call(phone, "tab.start", { rtab: "t1" }, conn);
		await settle();
		expected.push("new");
		const stored = storedSession("hosted.jsonl");
		await services.call(phone, "tab.open", { rtab: "t2", cwd: dir, sessionPath: stored }, conn);
		await services.call(phone, "tab.start", { rtab: "t2" }, conn);
		await settle();
		expected.push({ session: stored });

		// This computer relaunched: the device's interrupted tab comes back from its resume marker.
		const revived = storedSession("revived.jsonl");
		const id = services.reviveTab(phone, { tab: "peer:phone:t3", cwd: dir, kind: "agent", sessionPath: revived });
		services.startTab(id ?? "");
		await settle();
		expected.push({ session: revived });

		// An omp update restarts the device's idle tabs on their sessions.
		const before = omps.length;
		services.restartOnNewOmp();
		await settle();
		expected.push(...omps.slice(1, before).map(omp => ({ session: omp.session })));

		const [own, ...hosted] = omps.map(launchOf);
		expectOpens(
			[own, ...hosted].map(launch => launch?.open as Open),
			expected,
			before,
		);
		// The one difference beside the origin: a device's tab is told this computer's control socket is off to it.
		expect(own?.controlOff).toBeUndefined();
		for (const launch of hosted) {
			expect(launch.args).toEqual(own?.args);
			expect(launch.env).toEqual(own?.env);
			expect(launch.controlOff).toBe("1");
			expect(JSON.parse(launch.origin ?? "null")).toEqual({
				deviceId: "phone",
				name: "Phone phone",
				hostName: "Desk",
			});
		}
		expect(own?.origin).toBeUndefined();
	});
});

describe("a restart that names no session continues the tab's own", () => {
	it("an omp that crashed comes back on the session it was on", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const win = fakeWindow(1);
		const stored = storedSession("stored.jsonl");
		pool.acquire(dir, win, "stored-tab", stored);
		pool.acquire(dir, win, "new-tab", undefined, "agent", undefined, true);
		await settle();
		// The two start at once: told apart by how they opened their session.
		const onStored = omps.find(omp => launchOf(omp).open !== "new");
		const onNew = omps.find(omp => launchOf(omp).open === "new");

		await Promise.all([crash(onStored), crash(onNew)]);
		await settle();

		// Both come back within the same tenth of a second, in either order.
		const reopened = omps
			.slice(2)
			.map(launchOf)
			.map(launch => JSON.stringify(launch.open))
			.sort();
		expect(reopened).toEqual(
			[JSON.stringify({ session: stored }), JSON.stringify({ session: onNew?.session })].sort(),
		);
	});

	it("a crashed new tab whose session stock never wrote starts a new one, never another session", async () => {
		mode.writesNewSession = false;
		writeMode();
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		pool.acquire(dir, fakeWindow(1), "new-tab", undefined, "agent", undefined, true);
		await settle();

		await crash(omps[0]);
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual(["new", "new"]);
	});

	// formal/tab-session F1: the omp crashed after `ready`, before its get_state answer named the session.
	it("a new tab whose omp crashed before it named its session starts a new one, never another session", async () => {
		mode.answersState = false;
		writeMode();
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		pool.acquire(dir, fakeWindow(1), "new-tab", undefined, "agent", undefined, true);
		await settle();

		await crash(omps[0]);
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual(["new", "new"]);
	});

	it("a relaunch's saved tab that waited for omp opens its session once machine setup installed omp", async () => {
		spawned.ompInstalled = false;
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const win = fakeWindow(1);
		const saved = storedSession("saved.jsonl");
		pool.restoreLayout(win, {
			version: TAB_LAYOUT_VERSION,
			tabs: [{ cwd: dir, kind: "agent", sessionPath: saved }],
			activeIndex: 0,
		});
		for (const tab of pool.tabsForWindow(win)) pool.startTab(tab.tabId);
		await settle();
		expect(omps).toEqual([]);

		// index.ts `followSetupState`: every local tab that waited starts now.
		spawned.ompInstalled = true;
		for (const sidecar of pool.allSidecars()) if (sidecar.status === "waiting") sidecar.restart();
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual([{ session: saved }]);
	});

	it("the desktop slot's stop of a session's omp starts it again on that session", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const stored = storedSession("stored.jsonl");
		const sidecar = pool.acquire(dir, fakeWindow(1), "stored-tab", stored);
		await settle();

		// desktop-slot-host.ts `#kill`.
		sidecar?.restart();
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual([{ session: stored }, { session: stored }]);
	});

	it("a move to another folder starts a new session there", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const stored = storedSession("stored.jsonl");
		const sidecar = pool.acquire(dir, fakeWindow(1), "stored-tab", stored);
		await settle();

		// ipc.ts SIDECAR_SET_PROJECT.
		sidecar?.restart(tmpdir());
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual([{ session: stored }, "default"]);
	});

	it("a new tab whose omp named its session, moved to another folder, leaves the session there to omp", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const sidecar = pool.acquire(dir, fakeWindow(1), "new-tab", undefined, "agent", undefined, true);
		await settle();

		// ipc.ts SIDECAR_SELECT_PROJECT / SIDECAR_SET_PROJECT: being new is a creation contract, not a moved tab's.
		sidecar?.restart(tmpdir());
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual(["new", "default"]);
	});

	// formal/tab-session F2: the omp moved to another session in the tab, then crashed before a get_state named it.
	it("an omp that crashed after a switch_session comes back on the session switched to", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const stored = storedSession("stored.jsonl");
		const other = storedSession("other.jsonl");
		const sidecar = pool.acquire(dir, fakeWindow(1), "stored-tab", stored);
		await settle();

		mode.answersState = false;
		writeMode();
		await sidecar?.rpcClient?.command({ type: "switch_session", sessionPath: other });
		await crash(omps[0]);
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual([{ session: stored }, { session: other }]);
	});

	it("an omp that crashed after a new_session comes back on a new session, never the one before it", async () => {
		const create = factory();
		const pool = new SidecarPool((cwd, kind, fresh) => create(cwd, kind, fresh));
		const stored = storedSession("stored.jsonl");
		const sidecar = pool.acquire(dir, fakeWindow(1), "stored-tab", stored);
		await settle();

		mode.answersState = false;
		writeMode();
		await sidecar?.rpcClient?.command({ type: "new_session" });
		await crash(omps[0]);
		await settle();

		expect(omps.map(launchOf).map(launch => launch.open)).toEqual([{ session: stored }, "new"]);
	});
});

/**
 * The sessions the spawns opened against the ones expected, in order up to `before`; what an omp update restarted at once
 * (the spawns after it) started in no fixed order: the lanes run concurrently, where the in-memory spawn ran one by one.
 */
function expectOpens(actual: Open[], expected: Open[], before: number): void {
	expect(actual.slice(0, before)).toEqual(expected.slice(0, before));
	const ordered = (opens: Open[]) => opens.map(open => JSON.stringify(open)).sort();
	expect(ordered(actual.slice(before))).toEqual(ordered(expected.slice(before)));
}

/** What can happen to a tab between two spawns of its omp. */
const EVENTS = ["crash", "restart", "turn", "move", "open"] as const;
type TabEvent = (typeof EVENTS)[number];

function sequences(length: number): TabEvent[][] {
	if (length === 0) return [[]];
	return sequences(length - 1).flatMap(rest => EVENTS.map(event => [event, ...rest]));
}

describe("every spawn of a tab opens the session the tab is on", () => {
	// Each sequence of three events, from a new tab and from a stored session: a crash, a restart that names no
	// session (machine setup, the desktop slot), stock writing the session at a turn's answer, a move to another folder,
	// the person opening another stored session in the tab.
	const cases = (["new tab", "stored session"] as const).flatMap(start =>
		sequences(3).map(events => ({ start, events })),
	);
	it.each(cases)("$start, then $events", async ({ start, events }) => {
		mode.writesNewSession = false;
		writeMode();
		const create = factory();
		const other = mkdtempSync(join(tmpdir(), "launch-parity-other-"));
		const first = start === "stored session" ? storedSession("stored.jsonl") : undefined;
		const sidecar = create(dir, "agent", first === undefined);
		if (first) sidecar.restart(undefined, first);
		else sidecar.start();
		await settle();
		/** The session the tab is on as its user sees it, and whether it moved since that session was written. */
		let on: string | null = first ?? omps[0]?.session ?? null;
		let booted = false;
		const checked: string[] = [];
		const check = (): void => {
			for (const omp of omps.slice(checked.length)) {
				const { open } = launchOf(omp);
				const sessionWritten = on !== null && existsSync(on);
				// `--session` never names a file stock never wrote.
				if (typeof open === "object") expect(existsSync(open.session)).toBe(true);
				// The tab's written session is what every spawn reopens.
				if (sessionWritten) expect(open).toEqual({ session: on });
				// A tab with a session stock has not written yet, or a new tab before its first boot, never lets
				// stock's autoResume reopen another session in the folder.
				else if (on !== null || !booted) expect(open).toBe("new");
				// A tab whose omp named its session (each one here answers get_state), moved by the person to another
				// folder, leaves the session there to omp.
				else expect(open).toBe("default");
				checked.push(omp.session);
				on = omp.session;
				booted = true;
			}
		};
		try {
			check();
			for (const event of events) {
				const current = omps.at(-1);
				if (event === "crash") await crash(current);
				else if (event === "restart") sidecar.restart();
				else if (event === "turn" && current) writeFileSync(current.session, "{}\n");
				else if (event === "move") {
					sidecar.restart(other);
					on = null;
				} else {
					const opened = storedSession(`opened-${omps.length}.jsonl`);
					sidecar.restart(undefined, opened);
					on = opened;
				}
				await settle();
				check();
			}
		} finally {
			sidecar.dispose();
			// The omp may still be in `other` (its cwd after a move): the folder goes once it exited.
			await sidecar.whenExited();
			rmSync(other, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
	});
});
