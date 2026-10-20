import { describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabResult, SessionKind } from "../shared/ipc-types";
import type { SidecarLike } from "./sidecar-types";
import { type SpawnTabDeps, spawnTabForWindow } from "./tab-spawn";
import type { ClientWindow } from "./web/client-window";

/** Minimal window (only the identity fields the guard touches). */
function fakeWindow(id = 1): ClientWindow {
	return {
		webContents: { id, send: () => {} },
		isDestroyed: () => false,
		once: () => {},
		removeListener: () => {},
	};
}

interface Harness {
	deps: SpawnTabDeps;
	acquire: Mock<(...args: unknown[]) => SidecarLike>;
	kindFor: Mock<(path: string) => Promise<SessionKind>>;
	remoteKindFor: Mock<(device: string, path: string) => Promise<SessionKind>>;
	remoteDefaultWorkspace: Mock<(device: string) => Promise<string>>;
	sessionOwner: Mock<(path: string, device?: string) => { tabId: string; winId: number } | null>;
	fallbackCwd: Mock<(device: string | undefined) => string | null>;
	attachViewer: Mock<(win: ClientWindow, tabId: string) => boolean>;
}

/** acquire's placeholder/deferStart/title arguments for an explicit spawn; the device follows them. */
const SPAWNED = [false, false, undefined] as const;

function harness(): Harness {
	const acquire = vi.fn(() => ({}) as SidecarLike);
	const kindFor = vi.fn(async (_path: string): Promise<SessionKind> => "agent");
	const remoteKindFor = vi.fn(async (_device: string, _path: string): Promise<SessionKind> => "agent");
	const remoteDefaultWorkspace = vi.fn(async (_device: string) => "/host/work");
	const sessionOwner = vi.fn((_path: string, _device?: string): { tabId: string; winId: number } | null => null);
	const fallbackCwd = vi.fn((device: string | undefined): string | null => (device ? null : "/fallback"));
	const attachViewer = vi.fn((_win: ClientWindow, _tabId: string) => true);
	return {
		acquire,
		kindFor,
		remoteKindFor,
		remoteDefaultWorkspace,
		sessionOwner,
		fallbackCwd,
		attachViewer,
		deps: {
			sidecarPool: { sessionOwner, acquire, attachViewer } as unknown as SpawnTabDeps["sidecarPool"],
			sessionIndex: { kindFor },
			fallbackCwd,
			initialCwd: () => "/initial",
			defaultWorkspace: () => "/default-workspace",
			remote: { kindFor: remoteKindFor, defaultWorkspace: remoteDefaultWorkspace },
		},
	};
}

describe("spawnTabForWindow refusal contracts", () => {
	it("refuses an explicit chat payload against an agent file (I3: reject, never degrade)", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/agent.jsonl", kind: "chat" });

		expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		expect(acquire).not.toHaveBeenCalled();
		expect(kindFor).toHaveBeenCalledWith("/s/agent.jsonl");
	});

	it("refuses an explicit agent payload against a chat file", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind: "agent" });

		expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		expect(acquire).not.toHaveBeenCalled();
	});

	it("spawns with the file's kind when the payload omits it (file is authoritative)", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl" });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			"/default-workspace",
			expect.anything(),
			expect.any(String),
			"/s/chat.jsonl",
			"chat",
			undefined,
			false,
			...SPAWNED,
			undefined,
			undefined,
		);
	});

	it("acquires with the requested kind when it matches the file", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind: "chat" });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			"/default-workspace",
			expect.anything(),
			expect.any(String),
			"/s/chat.jsonl",
			"chat",
			undefined,
			false,
			...SPAWNED,
			undefined,
			undefined,
		);
	});

	it("owner wins over kind resolution (F-OWN checked first, kindFor not consulted)", async () => {
		const { deps, acquire, kindFor, sessionOwner } = harness();
		sessionOwner.mockReturnValue({ tabId: "t-owner", winId: 7 });
		const result: IpcSpawnTabResult | null = await spawnTabForWindow(deps, fakeWindow(), {
			sessionPath: "/s/owned.jsonl",
			kind: "chat",
		});

		expect(result).toEqual({ tabId: null, ownerTabId: "t-owner", ownerWinId: 7, refusal: "owned" });
		expect(kindFor).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("lets a web device's window view a session another window holds, and the other way round", async () => {
		const { deps, acquire, attachViewer, sessionOwner } = harness();
		sessionOwner.mockReturnValue({ tabId: "t-owner", winId: 7 });
		const phone = fakeWindow(-3);
		expect(await spawnTabForWindow(deps, phone, { sessionPath: "/s/a.jsonl" })).toEqual({
			tabId: "t-owner",
			attached: true,
		});
		expect(attachViewer).toHaveBeenCalledWith(phone, "t-owner");

		// A desktop window opening a session the phone owns views it too.
		sessionOwner.mockReturnValue({ tabId: "t-phone", winId: -3 });
		const desktop = fakeWindow(7);
		expect(await spawnTabForWindow(deps, desktop, { sessionPath: "/s/b.jsonl" })).toEqual({
			tabId: "t-phone",
			attached: true,
		});
		expect(attachViewer).toHaveBeenLastCalledWith(desktop, "t-phone");
		expect(acquire).not.toHaveBeenCalled();
	});

	it("keeps the refuse-or-focus rule between desktop windows and for the owner window itself", async () => {
		const { deps, attachViewer, sessionOwner } = harness();
		sessionOwner.mockReturnValue({ tabId: "t-owner", winId: 7 });
		expect(await spawnTabForWindow(deps, fakeWindow(8), { sessionPath: "/s/a.jsonl" })).toMatchObject({
			refusal: "owned",
		});
		sessionOwner.mockReturnValue({ tabId: "t-phone", winId: -3 });
		expect(await spawnTabForWindow(deps, fakeWindow(-3), { sessionPath: "/s/b.jsonl" })).toMatchObject({
			refusal: "owned",
		});
		expect(attachViewer).not.toHaveBeenCalled();
	});

	it("views a session a paired device's tab runs on this computer instead of spawning a second omp", async () => {
		const { deps, acquire, kindFor } = harness();
		const view = { kind: "agent", dispose: vi.fn() } as unknown as SidecarLike;
		const viewSession = vi.fn((path: string) => (path === "/s/hosted.jsonl" ? view : null));
		const acquireHostedView = vi.fn(() => true);
		const hostedDeps: SpawnTabDeps = {
			...deps,
			sidecarPool: { ...deps.sidecarPool, acquireHostedView } as unknown as SpawnTabDeps["sidecarPool"],
			hosted: { viewSession },
		};
		const win = fakeWindow(3);
		const result = await spawnTabForWindow(hostedDeps, win, { sessionPath: "/s/hosted.jsonl" });
		expect(result).toEqual({ tabId: expect.any(String), attached: true });
		expect(acquireHostedView).toHaveBeenCalledWith(win, result?.tabId, view, "/s/hosted.jsonl");
		expect(acquire).not.toHaveBeenCalled();
		expect(kindFor).not.toHaveBeenCalled();

		// Agent and chat never convert: a mismatched request leaves the device's tab alone.
		expect(await spawnTabForWindow(hostedDeps, win, { sessionPath: "/s/hosted.jsonl", kind: "chat" })).toEqual({
			tabId: null,
			refusal: "kind-mismatch",
		});
		expect(view.dispose).toHaveBeenCalledTimes(1);

		// A remote tab's session is never this computer's hosted one.
		await spawnTabForWindow(hostedDeps, win, { sessionPath: "/s/hosted.jsonl", device: "host-b" });
		expect(viewSession).toHaveBeenCalledTimes(2);
	});

	it("fresh tabs bypass auto-resume, spawn agent by default, and never consult kindFor", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/work" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith(
			"/work",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
			...SPAWNED,
			undefined,
			undefined,
		);
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("spawns Work as a full agent in the GUI default workspace", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { defaultWorkspace: true });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			"/default-workspace",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
			...SPAWNED,
			undefined,
			undefined,
		);
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("runs a fresh chat tab in the default workspace, never the caller's project", async () => {
		const { deps, acquire } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/project", kind: "chat" });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			"/default-workspace",
			expect.anything(),
			expect.any(String),
			undefined,
			"chat",
			undefined,
			true,
			...SPAWNED,
			undefined,
			undefined,
		);
	});

	it("passes a worktree binding through to acquire (plan/20)", async () => {
		const { deps, acquire } = harness();
		const worktree = {
			name: "fix-login",
			branch: "omp/gui/fix-login",
			baseCwd: "/repo",
			path: "/wt/gui-fix-login-deadbeef",
		};
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/wt/gui-fix-login-deadbeef", worktree });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith(
			"/wt/gui-fix-login-deadbeef",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			worktree,
			true,
			...SPAWNED,
			undefined,
			undefined,
		);
	});
});

describe("spawnTabForWindow on a paired host", () => {
	it("checks F-OWN and the file kind on the host, and runs a host chat in the host's default workspace", async () => {
		const { deps, acquire, kindFor, remoteKindFor, sessionOwner } = harness();
		remoteKindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), {
			device: "host-b",
			cwd: "/Users/b/project",
			sessionPath: "/Users/b/.omp/agent/sessions/x/s.jsonl",
		});

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/host/work" });
		expect(sessionOwner).toHaveBeenCalledWith("/Users/b/.omp/agent/sessions/x/s.jsonl", "host-b");
		expect(remoteKindFor).toHaveBeenCalledWith("host-b", "/Users/b/.omp/agent/sessions/x/s.jsonl");
		expect(kindFor).not.toHaveBeenCalled();
		expect(acquire).toHaveBeenCalledWith(
			"/host/work",
			expect.anything(),
			expect.any(String),
			"/Users/b/.omp/agent/sessions/x/s.jsonl",
			"chat",
			undefined,
			false,
			...SPAWNED,
			"host-b",
			undefined,
		);
	});

	it("keeps the host's cwd as given for an agent session", async () => {
		const { deps, acquire } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), {
			device: "host-b",
			cwd: "/Users/b/project",
			sessionPath: "/s/agent.jsonl",
		});

		expect(result).toEqual({ tabId: expect.any(String) });
		expect(acquire).toHaveBeenCalledWith(
			"/Users/b/project",
			expect.anything(),
			expect.any(String),
			"/s/agent.jsonl",
			"agent",
			undefined,
			false,
			...SPAWNED,
			"host-b",
			undefined,
		);
	});

	it("refuses a session another tab already holds on that host", async () => {
		const { deps, acquire, sessionOwner } = harness();
		sessionOwner.mockImplementation((_path, device) => (device === "host-b" ? { tabId: "t-b", winId: 2 } : null));
		const result = await spawnTabForWindow(deps, fakeWindow(), { device: "host-b", sessionPath: "/s/a.jsonl" });

		expect(result).toEqual({ tabId: null, ownerTabId: "t-b", ownerWinId: 2, refusal: "owned" });
		expect(acquire).not.toHaveBeenCalled();
	});

	it("opens in the host's Work workspace when no cwd on that host is known", async () => {
		const { deps, acquire, remoteDefaultWorkspace } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { device: "host-b" });

		expect(result).toEqual({ tabId: expect.any(String) });
		expect(remoteDefaultWorkspace).toHaveBeenCalledWith("host-b");
		expect(acquire).toHaveBeenCalledWith(
			"/host/work",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
			...SPAWNED,
			"host-b",
			undefined,
		);
	});

	it("returns the host's Work workspace for a defaultWorkspace spawn", async () => {
		const { deps } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { device: "host-b", defaultWorkspace: true });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/host/work" });
	});
});
