import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_OBJECTIVE,
	type AutopilotArmParams,
	type AutopilotBranchChoice,
	type AutopilotCycleRecord,
	type AutopilotStatus,
	DEFAULT_SHIP_POLICY,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { ExtensionUIRequest, RpcCommand, RpcResponse } from "../shared/rpc-types";
import {
	Autopilot,
	type AutopilotNotice,
	type AutopilotPool,
	localDate,
	RELEASE_NOW_MESSAGE,
	startSettings,
	validAutopilotPref,
} from "./autopilot";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { gitSync, initRepo } from "./local/git/test-repos";
import { createWorktree } from "./local/git/worktree";
import type { SidecarLike } from "./sidecar-types";
import type { RelaunchContinuation } from "./turn-resume";
import type { ClientWindow } from "./web/client-window";

// A start runs real git processes (branch facts, worktree, push target); on a loaded Windows runner one test
// crossed vitest's 5 s once (win-platform run 39111794694: "is not a run when the goal cannot be created").
vi.setConfig({ testTimeout: 30_000 });

interface Call {
	tab: string;
	kind: "bridge" | "stock";
	name: string;
	params?: Record<string, unknown>;
}

class FakeSidecar extends EventEmitter {
	status = "ready";
	device: string | undefined;
	readonly rpcClient: { command(command: RpcCommand): Promise<RpcResponse> };
	constructor(
		readonly tabId: string,
		readonly cwd: string,
		private readonly world: World,
	) {
		super();
		this.rpcClient = { command: command => this.world.handle(this.tabId, command) };
	}
}

/** The bridge's journal as far as the coordinator can tell, plus the stock commands it sends. */
class World {
	calls: Call[] = [];
	statuses = new Map<string, AutopilotStatus>();
	sidecars = new Map<string, FakeSidecar>();
	busy = new Set<string>();
	/** Tabs TurnResume holds a scheduled retry for. */
	scheduled = new Set<string>();
	released: string[] = [];
	stopped: string[] = [];
	answers: Array<{ id: string; tab: string; response: object }> = [];
	requests: Array<{ kind: "push" | "release"; quote: string; cycle: number; at: number }> = [];
	stats = new Map<string, { tokens: { total: number }; cost: number }>();
	plan = false;
	goal: { enabled: boolean; status?: string } = { enabled: false };
	failGoalCreate = false;
	failGoalResume = false;
	/** What the bridge answers `modes.autopilot_guide` with. */
	guide: unknown = { exists: false, text: "" };
	/** Stock's session name per tab (`set_session_name` / `get_state`). */
	sessionNames = new Map<string, string>();
	/** What the windows were told the session is called (`noteSessionName`). */
	shownNames = new Map<string, string>();

	handle(tab: string, command: RpcCommand): Promise<RpcResponse> {
		const ok = (data?: unknown) => Promise.resolve({ type: "response", success: true, data } as RpcResponse);
		const fail = (error: string) => Promise.resolve({ type: "response", success: false, error } as RpcResponse);
		if (command.type === "autopilot_bridge") {
			const params = (command.params ?? {}) as Record<string, unknown>;
			this.calls.push({ tab, kind: "bridge", name: command.method, params });
			return ok(this.bridge(tab, command.method, params));
		}
		const { type, ...rest } = command as unknown as { type: string } & Record<string, unknown>;
		this.calls.push({ tab, kind: "stock", name: type, params: rest });
		if (type === "get_plan_mode") return ok({ enabled: this.plan });
		if (type === "get_goal") return ok(this.goal);
		if (type === "get_session_stats") return ok(this.stats.get(tab) ?? { tokens: { total: 0 }, cost: 0 });
		if (type === "set_session_name") this.sessionNames.set(tab, String(rest.name));
		if (type === "get_state") return ok({ sessionName: this.sessionNames.get(tab) ?? null });
		if (type === "set_goal" && rest.objective && this.failGoalCreate) return fail("goal refused");
		if (type === "set_goal" && rest.action === "resume" && this.failGoalResume)
			return fail("No paused goal to resume.");
		return ok({});
	}

	bridge(tab: string, method: string, params: Record<string, unknown>): unknown {
		const current = this.statuses.get(tab);
		switch (method) {
			case AUTOPILOT_BRIDGE_METHODS.arm: {
				const arm = params as unknown as AutopilotArmParams;
				const status: AutopilotStatus = {
					active: true,
					state: "running",
					role: arm.role,
					run: arm.run,
					root: arm.root,
					branch: arm.branch,
					baseBranch: arm.baseBranch,
					...(arm.target ? { target: arm.target } : {}),
					cycle: current?.cycle ?? 0,
					settings: arm.settings,
					cycles: current?.cycles ?? [],
					ship: { policy: arm.settings.ship, queue: [] },
				};
				this.statuses.set(tab, status);
				return status;
			}
			case AUTOPILOT_BRIDGE_METHODS.status:
				return current ?? { active: false };
			case AUTOPILOT_BRIDGE_METHODS.setState: {
				if (current) {
					current.state = params.state as AutopilotStatus["state"];
					current.reason = params.reason as AutopilotStatus["reason"];
					current.detail = params.detail as string | undefined;
					if ("inFlight" in params && current.ship) {
						current.ship.inFlight = (params.inFlight as never) ?? undefined;
					}
				}
				return current;
			}
			case AUTOPILOT_BRIDGE_METHODS.guide:
				return this.guide;
			case AUTOPILOT_BRIDGE_METHODS.takeShipRequests:
				return { requests: this.requests.splice(0) };
			case AUTOPILOT_BRIDGE_METHODS.disarm:
				if (current) current.state = "ended";
				return current;
			default:
				return current;
		}
	}

	names(tab: string, kind?: Call["kind"]): string[] {
		return this.calls.filter(call => call.tab === tab && (!kind || call.kind === kind)).map(call => call.name);
	}

	stock(tab: string, name: string): Call[] {
		return this.calls.filter(call => call.tab === tab && call.kind === "stock" && call.name === name);
	}

	bridgeCalls(tab: string, method: string): Call[] {
		return this.calls.filter(call => call.tab === tab && call.kind === "bridge" && call.name === method);
	}

	/** The configure calls that carried a release status (the empty ones are the screen refreshes). */
	releaseCalls(tab: string): Call[] {
		return this.bridgeCalls(tab, AUTOPILOT_BRIDGE_METHODS.configure).filter(call => "release" in (call.params ?? {}));
	}

	addTab(tabId: string, cwd: string): FakeSidecar {
		const sidecar = new FakeSidecar(tabId, cwd, this);
		this.sidecars.set(tabId, sidecar);
		return sidecar;
	}
}

let tmp = "";
let main = "";
let remote = "";
let world: World;
let notices: AutopilotNotice[];
let polls: Array<{ run: () => void; stopped: boolean }>;
let afters: Array<() => void>;
let releaseState: { status: string; conclusion: string | null } | null;
let autopilot: Autopilot;
let nextTab = 0;
const clock = { value: 1_000 };
const win = {} as ClientWindow;

function text(key: MainTextKey, params?: Record<string, string | number>): string {
	return MAIN_TEXT[key].en.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in (params ?? {}) ? String(params?.[name]) : match,
	);
}

function build(
	over: { releaseProcedure?: boolean; relaunch?: RelaunchContinuation; prefs?: Record<string, unknown> } = {},
): void {
	const pool: AutopilotPool = {
		sidecarOf: tab => (world.sidecars.get(tab) as unknown as SidecarLike | undefined) ?? null,
		tabFacts: tab =>
			world.sidecars.has(tab) ? { busy: world.busy.has(tab), scheduledRetry: world.scheduled.has(tab) } : null,
		releaseTabWhenExited: async tab => {
			world.released.push(tab);
			world.sidecars.delete(tab);
		},
		noteStopped: tab => {
			world.stopped.push(tab);
		},
		noteSessionName: (tab, title) => {
			world.shownNames.set(tab, title);
		},
		routeSideChannel: async (id, response, tab) => {
			world.answers.push({ id, tab: tab ?? "", response });
			return true;
		},
	};
	autopilot = new Autopilot({
		pool,
		dispatch: async (_win, _sidecar, _tab, command) => {
			if (command.type !== "worktree_create") throw new Error("unexpected dispatch");
			if (command.branch) {
				// A branch the caller names goes through the real `worktree_create`.
				const bridge = { request: async <T>() => ({ root: path.join(tmp, "wts"), hash: "abc1234" }) as T };
				try {
					const made = await createWorktree(
						main,
						{ name: command.name, baseCwd: main, branch: command.branch },
						bridge,
					);
					return { type: "response", success: true, data: made } as RpcResponse;
				} catch (error) {
					return { type: "response", success: false, error: String(error) } as RpcResponse;
				}
			}
			// Like the real `worktree_create`: a taken name gets `-2`, `-3`, ...
			let name: string = command.name;
			for (let suffix = 2; gitSync(main, "branch", "--list", `autopilot/${name}`) !== ""; suffix++) {
				name = `${command.name}-${suffix}`;
			}
			const branch = `autopilot/${name}`;
			const dir = path.join(tmp, `wt-${name}`);
			gitSync(main, "worktree", "add", "-q", "-b", branch, dir);
			return { type: "response", success: true, data: { path: dir, branch, baseCwd: main } } as RpcResponse;
		},
		spawnTab: async (_win, payload) => {
			const tabId = `ap-${++nextTab}`;
			const sidecar = world.addTab(tabId, payload.cwd ?? "");
			autopilot.attachSidecar(tabId, sidecar as unknown as SidecarLike);
			return { tabId };
		},
		prefs: { get: key => over.prefs?.[key] },
		notify: (_tab, notice) => {
			notices.push(notice);
		},
		text,
		ghRun: async () => releaseState,
		prCreate: async () => ({ url: "https://github.com/o/r/pull/1", number: 1 }),
		relaunchContinuation: () => over.relaunch ?? "now",
		now: () => clock.value,
		today: () => "2026-10-17",
		after: run => {
			afters.push(run);
			return () => undefined;
		},
		setTimer: run => {
			const entry = { run, stopped: false };
			polls.push(entry);
			return () => {
				entry.stopped = true;
			};
		},
		detectRelease: async () => (over.releaseProcedure ? { file: "AGENTS.md", anchors: ["Release"] } : null),
		log: () => undefined,
	});
	autopilot.attachControl({ childrenOf: () => [], clearQueue: async () => undefined });
}

async function start(options: Parameters<Autopilot["handleCommand"]>[3] = { type: "set_autopilot", action: "start" }) {
	const sidecar = world.addTab("parent", main);
	autopilot.attachSidecar("parent", sidecar as unknown as SidecarLike);
	const response = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "parent", options, "1");
	return { response, sidecar };
}

const record = (over: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord => ({
	n: 1,
	area: "tests",
	title: "Add a test",
	summary: "s",
	verify: "green",
	followups: [],
	children: [],
	startedAt: 1,
	durationMs: 1000,
	tokens: 10,
	usd: 0.1,
	compactions: 0,
	...over,
});

async function commit(cwd: string, name: string): Promise<string> {
	await fs.writeFile(path.join(cwd, name), name);
	gitSync(cwd, "add", name);
	gitSync(cwd, "commit", "-q", "-m", name);
	return gitSync(cwd, "rev-parse", "HEAD");
}

// One repository with its bare remote, built once (a dozen git processes) and copied for each test.
let template = "";
beforeAll(async () => {
	template = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-template-")));
	const repo = path.join(template, "main");
	await initRepo(repo);
	gitSync(template, "init", "-q", "--bare", "-b", "main", path.join(template, "remote.git"));
	gitSync(repo, "remote", "add", "origin", path.join(template, "remote.git"));
	gitSync(repo, "push", "-q", "origin", "main");
});

afterAll(async () => {
	await fs.rm(template, { recursive: true, force: true });
});

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-main-")));
	await fs.cp(template, tmp, { recursive: true });
	main = path.join(tmp, "main");
	remote = path.join(tmp, "remote.git");
	gitSync(main, "remote", "set-url", "origin", remote);
	world = new World();
	notices = [];
	polls = [];
	afters = [];
	releaseState = null;
	nextTab = 0;
	build();
});

afterEach(async () => {
	// A ship's git child can still hold the folder for a moment on Windows (EBUSY).
	await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("pure helpers", () => {
	it("localDate is the local YYYY-MM-DD", () => {
		expect(localDate(new Date(2026, 9, 7))).toBe("2026-10-07");
	});

	it("startSettings layers defaults, stored prefs, a preset and the explicit values", () => {
		expect(startSettings({}, {}).ship).toEqual(DEFAULT_SHIP_POLICY);
		expect(startSettings({ preset: "push" }, {}).ship).toMatchObject({ autoPush: true, autoRelease: { on: false } });
		expect(startSettings({ preset: "release" }, {}).ship).toMatchObject({
			autoPush: true,
			autoRelease: { on: true },
		});
		expect(startSettings({ ship: { remote: "up" } }, {}).ship.remote).toBe("up");
		expect(startSettings({ maxParallel: 9 }, {}).maxParallel).toBe(9);
		expect(startSettings({ maxParallel: -2 }, {}).maxParallel).toBe(0);
		expect(startSettings({}, {}).maxParallel).toBeNull();
		expect(startSettings({}, { notify: "cycles" }).notify).toBe("cycles");
		expect(startSettings({ notify: "off" }, { notify: "cycles" }).notify).toBe("off");
		expect(
			startSettings({ limits: { cycles: 3 } }, { limits: { tokens: 5, minutes: null, cycles: null, usd: null } })
				.limits,
		).toEqual({
			tokens: 5,
			minutes: null,
			cycles: 3,
			usd: null,
		});
	});

	it("validAutopilotPref accepts the shapes the sheet stores and refuses anything else", () => {
		expect(validAutopilotPref("autopilotNotify", "cycles")).toBe(true);
		expect(validAutopilotPref("autopilotNotify", "loud")).toBe(false);
		expect(validAutopilotPref("autopilotShip", DEFAULT_SHIP_POLICY)).toBe(true);
		expect(validAutopilotPref("autopilotShip", { ...DEFAULT_SHIP_POLICY, remote: "--upload-pack=x" })).toBe(false);
		expect(
			validAutopilotPref("autopilotShip", {
				...DEFAULT_SHIP_POLICY,
				autoRelease: { on: true, cadence: { kind: "every", n: 0 } },
			}),
		).toBe(false);
		expect(
			validAutopilotPref("autopilotShip", {
				...DEFAULT_SHIP_POLICY,
				autoRelease: { on: true, cadence: { kind: "agent" } },
			}),
		).toBe(true);
		expect(validAutopilotPref("autopilotShip", "origin")).toBe(false);
	});
});

describe("start", () => {
	it("opens a worktree tab, arms the bridge and only then creates the stock goal", async () => {
		const { response } = await start({ type: "set_autopilot", action: "start", preset: "push", focus: ["tests"] });
		expect(response.success).toBe(true);
		const data = dataOf<AutopilotStatus & { tabId: string }>(response);
		expect(data.tabId).toBe("ap-1");
		expect(data).toMatchObject({ active: true, branch: "autopilot/2026-10-17", baseBranch: "main" });
		const calls = world.calls.filter(call => call.tab === "ap-1");
		const arm = calls.findIndex(call => call.name === AUTOPILOT_BRIDGE_METHODS.arm);
		const create = calls.findIndex(call => call.name === "set_goal" && call.params?.objective);
		expect(arm).toBeGreaterThanOrEqual(0);
		expect(create).toBeGreaterThan(arm);
		expect(calls[create]?.params).toEqual({ objective: AUTOPILOT_OBJECTIVE });
		expect(calls[arm]?.params).toMatchObject({
			role: "parent",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			settings: { focus: ["tests"], ship: { autoPush: true } },
		});
		expect(await fs.stat(path.join(tmp, "wt-2026-10-17"))).toBeTruthy();
	});

	it("titles the run's session from the start, then by its first cycle's item, never over the user's own name", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		expect(world.sessionNames.get("ap-1")).toBe(`Autopilot · ${path.basename(main)}`);
		const base = world.statuses.get("ap-1") as AutopilotStatus;
		const picked = { ...base, now: { n: 1, startedAt: 1, area: "bugs" as const, title: "Fix slugify spaces" } };
		autopilot.overlay(sidecar, { type: "autopilot_update", status: picked });
		await vi.waitFor(() => expect(world.sessionNames.get("ap-1")).toBe("Autopilot · Fix slugify spaces"));
		// Stock sends no update for an RPC rename: the windows are told by main.
		expect(world.shownNames.get("ap-1")).toBe("Autopilot · Fix slugify spaces");
		// The user renames it; a later cycle-1 frame changes nothing.
		world.sessionNames.set("ap-1", "mine");
		autopilot.overlay(sidecar, {
			type: "autopilot_update",
			status: { ...picked, now: { ...picked.now, title: "x" } },
		});
		await autopilot.idle();
		expect(world.sessionNames.get("ap-1")).toBe("mine");
	});

	describe("the ship level nobody chose", () => {
		const armedPolicy = () => {
			const arm = world.calls.find(call => call.tab === "ap-1" && call.name === AUTOPILOT_BRIDGE_METHODS.arm);
			const settings = arm?.params?.settings;
			return settings && typeof settings === "object" && "ship" in settings ? settings.ship : undefined;
		};
		it("stays local in a repository without a remote", async () => {
			gitSync(main, "remote", "remove", "origin");
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ autoPush: false, autoRelease: { on: false } });
		});
		it("pushes the run's own new branch when the repository has a remote, never releases", async () => {
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ autoPush: true, autoRelease: { on: false }, remote: "origin" });
		});
		it("stays local when the run would push the default branch", async () => {
			await start({ type: "set_autopilot", action: "start", branch: { kind: "existing", name: "main" } });
			expect(armedPolicy()).toMatchObject({ autoPush: false });
		});
		it("an explicit level wins", async () => {
			await start({ type: "set_autopilot", action: "start", preset: "local" });
			expect(armedPolicy()).toMatchObject({ autoPush: false });
		});
	});

	it("pins the sheet's backlog items once the run is armed and before the goal exists", async () => {
		const { response } = await start({
			type: "set_autopilot",
			action: "start",
			backlog: ["fix the flaky test", "document the CLI"],
		});
		expect(response.success).toBe(true);
		const calls = world.calls.filter(call => call.tab === "ap-1");
		const names = calls.map(call => call.name);
		const pinned = calls.filter(call => call.name === AUTOPILOT_BRIDGE_METHODS.backlog);
		expect(pinned.map(call => call.params)).toEqual([
			{ op: "add", text: "fix the flaky test" },
			{ op: "add", text: "document the CLI" },
		]);
		expect(names.indexOf(AUTOPILOT_BRIDGE_METHODS.backlog)).toBeGreaterThan(
			names.indexOf(AUTOPILOT_BRIDGE_METHODS.arm),
		);
		expect(names.lastIndexOf(AUTOPILOT_BRIDGE_METHODS.backlog)).toBeLessThan(names.indexOf("set_goal"));
	});

	it("commits the sheet's guide as the branch's first commit and leaves the user's branch alone", async () => {
		const { response } = await start({
			type: "set_autopilot",
			action: "start",
			guide: "# Guide\n\nSmall diffs.",
		});
		expect(response.success).toBe(true);
		const worktree = path.join(tmp, "wt-2026-10-17");
		expect(await fs.readFile(path.join(worktree, "AUTOPILOT.md"), "utf8")).toBe("# Guide\n\nSmall diffs.\n");
		expect(gitSync(worktree, "log", "--format=%s", "main..HEAD")).toBe("docs: add AUTOPILOT.md guide");
		expect(gitSync(worktree, "show", "--name-only", "--format=", "HEAD")).toBe("AUTOPILOT.md");
		expect(gitSync(worktree, "status", "--porcelain")).toBe("");
		await expect(fs.access(path.join(main, "AUTOPILOT.md"))).rejects.toThrow();
		expect(gitSync(main, "log", "--format=%s", "main").split("\n")).not.toContain("docs: add AUTOPILOT.md guide");
	});

	it("commits nothing when the sheet's guide is the repo's own text", async () => {
		await fs.writeFile(path.join(main, "AUTOPILOT.md"), "# Ours\n");
		gitSync(main, "add", "AUTOPILOT.md");
		gitSync(main, "commit", "-q", "-m", "add guide");
		await start({ type: "set_autopilot", action: "start", guide: "# Ours\n" });
		expect(gitSync(path.join(tmp, "wt-2026-10-17"), "log", "--format=%s", "main..HEAD")).toBe("");
	});

	it("commits an edit of the repo's own guide as an update", async () => {
		await fs.writeFile(path.join(main, "AUTOPILOT.md"), "# Ours\n");
		gitSync(main, "add", "AUTOPILOT.md");
		gitSync(main, "commit", "-q", "-m", "add guide");
		await start({ type: "set_autopilot", action: "start", guide: "# Ours\n\nEdited.\n" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		expect(gitSync(worktree, "log", "--format=%s", "main..HEAD")).toBe("docs: update AUTOPILOT.md guide");
		expect(await fs.readFile(path.join(worktree, "AUTOPILOT.md"), "utf8")).toBe("# Ours\n\nEdited.\n");
	});

	it("asks the bridge for the repo's guide with the status, and for a draft only on guide_draft", async () => {
		const sidecar = world.addTab("sheet", main);
		autopilot.attachSidecar("sheet", sidecar as unknown as SidecarLike);
		world.guide = { exists: false, text: "" };
		const idle = await autopilot.status(sidecar as unknown as SidecarLike, "sheet");
		expect(idle).toMatchObject({ active: false, guide: { exists: false, text: "" } });
		expect(world.bridgeCalls("sheet", AUTOPILOT_BRIDGE_METHODS.guide)[0]?.params).toMatchObject({
			root: expect.any(String),
			draft: false,
		});
		world.guide = { exists: false, text: "# Draft\n", draft: "template" };
		const drafted = await autopilot.handleCommand(
			win,
			sidecar as unknown as SidecarLike,
			"sheet",
			{ type: "set_autopilot", action: "guide_draft" },
			"2",
		);
		expect(dataOf<AutopilotStatus>(drafted)).toMatchObject({
			active: false,
			guide: { text: "# Draft\n", draft: "template" },
			ship: { queue: [] },
		});
		expect(world.bridgeCalls("sheet", AUTOPILOT_BRIDGE_METHODS.guide).at(-1)?.params).toMatchObject({ draft: true });
	});

	it("passes a token ceiling to stock as the goal's budget and never a time limit", async () => {
		await start({ type: "set_autopilot", action: "start", limits: { tokens: 50_000, minutes: 30 } });
		expect(world.stock("ap-1", "set_goal")[0]?.params).toEqual({
			objective: AUTOPILOT_OBJECTIVE,
			tokenBudget: 50_000,
		});
	});

	it("refuses with a readable sentence: not a repository, detached HEAD, plan on, a goal, a device tab", async () => {
		const outside = world.addTab("outside", tmp);
		const refused = async (sidecar: FakeSidecar, tab = sidecar.tabId) =>
			errorOf(
				await autopilot.handleCommand(
					win,
					sidecar as unknown as SidecarLike,
					tab,
					{ type: "set_autopilot", action: "start" },
					"1",
				),
			);
		expect(await refused(outside)).toMatch(/git repository/);
		const inMain = world.addTab("m", main);
		world.plan = true;
		expect(await refused(inMain)).toMatch(/Plan mode/);
		world.plan = false;
		world.goal = { enabled: true, status: "active" };
		expect(await refused(inMain)).toMatch(/already has a goal/);
		world.goal = { enabled: false };
		const device = world.addTab("d", main);
		device.device = "phone";
		expect(await refused(device)).toMatch(/this computer/);
		gitSync(main, "checkout", "-q", "--detach");
		expect(await refused(inMain)).toMatch(/Check out a branch/);
		expect(world.calls.some(call => call.name === AUTOPILOT_BRIDGE_METHODS.arm)).toBe(false);
		expect(nextTab).toBe(0);
	});

	it("refuses a release start without a release procedure, and allows it with one", async () => {
		const sidecar = world.addTab("m", main);
		const command = { type: "set_autopilot", action: "start", preset: "release" } as const;
		const refused = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", command, "1");
		expect(errorOf(refused)).toMatch(/release procedure/i);
		expect(refused).toMatchObject({ success: false, code: "autopilot_no_release" });
		// Nothing was created: no run tab, no autopilot branch.
		expect(nextTab).toBe(0);
		expect(gitSync(main, "branch", "--list", "autopilot/*")).toBe("");
		build({ releaseProcedure: true });
		const ok = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", command, "2");
		expect(ok.success).toBe(true);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			releaseProcedure: { file: "AGENTS.md", anchors: ["Release"] },
		});
	});

	it("is not a run when the goal cannot be created: disarmed, no run", async () => {
		world.failGoalCreate = true;
		const { response, sidecar } = await start();
		expect(errorOf(response)).toMatch(/goal refused/);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		const status = await autopilot.status(sidecar as unknown as SidecarLike, "ap-1");
		expect(status.state).toBe("ended");
	});

	it("answers get_autopilot on a tab that is no run with the sheet's facts", async () => {
		build({ releaseProcedure: true });
		const sidecar = world.addTab("m", main);
		const status = await autopilot.status(sidecar as unknown as SidecarLike, "m");
		expect(status).toMatchObject({
			active: false,
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [], releaseProcedure: { file: "AGENTS.md" } },
		});
		build();
		expect((await autopilot.status(sidecar as unknown as SidecarLike, "m")).ship?.releaseBlocked).toMatch(
			/release procedure/i,
		);
	});
});

describe("the branch a run is on", () => {
	const startOn = (branch: AutopilotBranchChoice, extra: { preset?: "push" } = {}) =>
		start({ type: "set_autopilot", action: "start", branch, ...extra });
	const rootOf = (response: RpcResponse) => dataOf<AutopilotStatus>(response).root ?? "";
	const refusal = (response: RpcResponse) => ({
		error: errorOf(response),
		code: "code" in response ? response.code : undefined,
	});
	const armed = () => world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params;
	async function cycleEnd(n = 1): Promise<void> {
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ n }),
		});
		await autopilot.idle();
	}

	beforeEach(() => {
		gitSync(main, "branch", "feature/x");
		gitSync(main, "push", "-q", "origin", "feature/x");
		// On the remote only: pushed, then deleted locally.
		gitSync(main, "branch", "remote-only");
		gitSync(main, "push", "-q", "origin", "remote-only");
		gitSync(main, "branch", "-D", "remote-only");
	});

	it("checks an existing local branch out in the new worktree and commits there; nothing is named autopilot/", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" });
		expect(response.success).toBe(true);
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({
			active: true,
			branch: "feature/x",
			baseBranch: "main",
			run: "2026-10-17",
		});
		expect(gitSync(rootOf(response), "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
		expect(armed()).toMatchObject({ role: "parent", branch: "feature/x", baseBranch: "main", run: "2026-10-17" });
		expect(gitSync(main, "branch", "--list", "autopilot/*")).toBe("");
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});

	it("tracks a branch that is only on the remote", async () => {
		const { response } = await startOn({ kind: "existing", name: "remote-only" });
		expect(response.success).toBe(true);
		const root = rootOf(response);
		expect(gitSync(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("remote-only");
		expect(gitSync(root, "rev-parse", "--abbrev-ref", "remote-only@{upstream}")).toBe("origin/remote-only");
		expect(armed()).toMatchObject({ branch: "remote-only" });
	});

	it("a new branch takes the name the user typed, exactly", async () => {
		const { response } = await startOn({ kind: "new", name: "work/mine" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "work/mine", run: "2026-10-17" });
		expect(gitSync(rootOf(response), "rev-parse", "--abbrev-ref", "HEAD")).toBe("work/mine");
		expect(gitSync(main, "rev-parse", "work/mine")).toBe(gitSync(main, "rev-parse", "main"));
	});

	it("a name under autopilot/ keeps the run id the children are named from", async () => {
		const { response } = await startOn({ kind: "new", name: "autopilot/night-shift" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "autopilot/night-shift", run: "night-shift" });
	});

	it("main while the user's own folder is on it: the run works on its own branch cut from main, Push goes to HEAD:main and the folder is untouched", async () => {
		await fs.writeFile(path.join(main, "mine.txt"), "user work");
		const mainBefore = gitSync(main, "rev-parse", "main");
		const { response } = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(response.success).toBe(true);
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({
			branch: "autopilot/2026-10-17",
			target: "main",
			baseBranch: "main",
		});
		expect(armed()).toMatchObject({ branch: "autopilot/2026-10-17", target: "main" });
		const sha = await commit(rootOf(response), "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/main"],
			sha,
		});
		// The user's folder: still on main, local main not moved, their file there, nothing else changed.
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(gitSync(main, "rev-parse", "main")).toBe(mainBefore);
		expect(await fs.readFile(path.join(main, "mine.txt"), "utf8")).toBe("user work");
		expect(gitSync(main, "status", "--porcelain")).toBe("?? mine.txt");
	});

	it("any branch another worktree holds is a target too: the run works beside it and pushes to it, never forced", async () => {
		const other = path.join(tmp, "elsewhere");
		gitSync(main, "worktree", "add", "-q", other, "feature/x");
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "autopilot/2026-10-17", target: "feature/x" });
		const sha = await commit(rootOf(response), "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		// The remote target moves on elsewhere: the next push is rejected, reported to the agent, not forced, not a stop.
		const theirs = path.join(tmp, "theirs2");
		gitSync(tmp, "clone", "-q", remote, theirs);
		gitSync(theirs, "config", "user.email", "t@example.com");
		gitSync(theirs, "config", "user.name", "T");
		gitSync(theirs, "switch", "-q", "feature/x");
		const moved = await commit(theirs, "theirs.txt");
		gitSync(theirs, "push", "-q", "origin", "feature/x");
		await commit(rootOf(response), "b.txt");
		await cycleEnd(2);
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(moved);
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/origin\/feature\/x has commits this run lacks.*never forces/,
		);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("a PR is opened from the push target, so a target that is the base branch has none to open (merge still has work to land)", async () => {
		const toBase = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(dataOf<AutopilotStatus>(toBase.response)).toMatchObject({
			branch: "autopilot/2026-10-17",
			target: "main",
		});
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const pr = (id: string) =>
			autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "pr" }, id);
		expect(refusal(await pr("8"))).toMatchObject({ code: "autopilot_on_base" });
		// Merge still has work to land: the run's own branch is not the base.
		const merged = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "merge" },
			"9",
		);
		expect(merged.success).toBe(true);
	});

	it("refuses a branch that is gone, a new name that is taken and one git would not accept", async () => {
		const missing = (await startOn({ kind: "existing", name: "ghost" })).response;
		expect(refusal(missing)).toMatchObject({ code: "autopilot_branch_missing" });
		const taken = (await startOn({ kind: "new", name: "feature/x" })).response;
		expect(refusal(taken)).toMatchObject({ code: "autopilot_branch_exists" });
		const invalid = (await startOn({ kind: "new", name: "bad name" })).response;
		expect(refusal(invalid)).toMatchObject({ code: "autopilot_branch_invalid" });
		const garbage = (await startOn({ kind: "bogus" } as unknown as AutopilotBranchChoice)).response;
		expect(refusal(garbage)).toMatchObject({ code: "autopilot_branch_invalid" });
		expect(nextTab).toBe(0);
	});

	it("the default branch is allowed once the user's folder is off it: the run commits on it, Push pushes to it", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		const { response } = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(response.success).toBe(true);
		// A run on the default branch has itself as its base (a release pushes it).
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "main", baseBranch: "main" });
		const root = rootOf(response);
		const sha = await commit(root, "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/main"],
			sha,
		});
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params?.state).toBe("running");
		// The user's own folder was not touched.
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev");
	});

	it("Push goes to the chosen branch under the same name and never to main", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		const sha = await commit(rootOf(response), "a.txt");
		const mainBefore = gitSync(remote, "rev-parse", "refs/heads/main");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/feature/x"],
			sha,
		});
	});

	it("never forces: a remote branch that moved on is reported to the agent, not a stop", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		const theirs = path.join(tmp, "theirs");
		gitSync(tmp, "clone", "-q", remote, theirs);
		gitSync(theirs, "config", "user.email", "t@example.com");
		gitSync(theirs, "config", "user.name", "T");
		gitSync(theirs, "switch", "-q", "feature/x");
		const moved = await commit(theirs, "theirs.txt");
		gitSync(theirs, "push", "-q", "origin", "feature/x");
		await commit(rootOf(response), "mine.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(moved);
		const note = String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text);
		expect(note).toMatch(/not a fast-forward.*never forces/);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("merge and PR have nothing to do on the default branch itself", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		await startOn({ kind: "existing", name: "main" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		for (const kind of ["merge", "pr"] as const) {
			const refused = await autopilot.handleCommand(
				win,
				sidecar,
				"ap-1",
				{ type: "set_autopilot", action: "ship", kind },
				"9",
			);
			expect(refusal(refused)).toMatchObject({ code: "autopilot_on_base" });
		}
	});

	it("a cycle's audit judges the chosen branch: its own commits pass, another branch moving is a violation", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" });
		const root = rootOf(response);
		await commit(root, "a.txt");
		await cycleEnd(1);
		expect(
			world
				.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
				.some(call => call.params?.reason === "ban_violation"),
		).toBe(false);
		// An `autopilot/` branch is no longer trusted just for its prefix.
		gitSync(root, "branch", "autopilot/sneaky");
		await cycleEnd(2);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "ban_violation",
		});
	});

	it("gives the sheet the branches, the suggestion and the choice remembered for this repository", async () => {
		build({
			prefs: { autopilotBranch: { [main]: { kind: "existing", name: "feature/x" }, "/other": { kind: "new" } } },
		});
		const sidecar = world.addTab("m", main);
		const status = dataOf<AutopilotStatus>(
			await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", { type: "get_autopilot" }, "1"),
		);
		expect(status.branches).toMatchObject({
			repo: main,
			remote: "origin",
			defaultBranch: "main",
			suggested: "autopilot/2026-10-17",
			last: { kind: "existing", name: "feature/x" },
		});
		const byName = Object.fromEntries((status.branches?.branches ?? []).map(entry => [entry.name, entry]));
		expect(byName.main).toMatchObject({ default: true, current: true, checkedOutAt: main });
		expect(byName["feature/x"]).toMatchObject({ local: true, remote: true });
		expect(byName["remote-only"]).toMatchObject({ local: false, remote: true });
		// The branch is per run: the ship defaults carry none.
		expect(Object.keys(status.ship?.policy ?? {}).sort()).toEqual(["autoPush", "autoRelease", "remote"]);
	});

	it("validAutopilotPref accepts the remembered choices per repository and nothing else", () => {
		expect(
			validAutopilotPref("autopilotBranch", { "/r": { kind: "existing", name: "dev" }, "/s": { kind: "new" } }),
		).toBe(true);
		expect(validAutopilotPref("autopilotBranch", { "/r": { kind: "existing" } })).toBe(false);
		expect(validAutopilotPref("autopilotBranch", "dev")).toBe(false);
	});
});

describe("stop", () => {
	it("an idle run stops at once: goal paused, bridge stopping, then ended, dropped, disarmed, one notice", async () => {
		await start();
		const response = await autopilot.handleCommand(
			win,
			world.sidecars.get("ap-1") as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		const states = world
			.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
			.map(call => [call.params?.state, call.params?.reason]);
		expect(states).toEqual([
			["stopping", "user"],
			["ended", "user"],
		]);
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual([
			"create",
			"pause",
			"drop",
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		expect(notices).toEqual([expect.objectContaining({ kind: "completion", title: "Autopilot ended" })]);
		expect(autopilot.isStopping("ap-1")).toBe(false);
	});

	it("a run mid-turn keeps going until the bridge says the last turn settled", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.busy.add("ap-1");
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "stop" }, "2");
		await autopilot.idle();
		expect(autopilot.isStopping("ap-1")).toBe(true);
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create", "pause"]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(0);
		autopilot.frame(sidecar, { type: "autopilot_settled", reason: "user" });
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual([
			"create",
			"pause",
			"drop",
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		expect(notices).toHaveLength(1);
	});

	it("empties a child's queue on stop without aborting it", async () => {
		const cleared: string[] = [];
		autopilot.attachControl({ childrenOf: () => [], clearQueue: async tab => void cleared.push(tab) });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.addTab("child-1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/x" },
		});
		world.busy.add("ap-1");
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "stop" }, "2");
		expect(cleared).toEqual(["child-1"]);
		expect(world.stock("child-1", "abort")).toHaveLength(0);
	});

	it("a stopping run refuses new sessions", async () => {
		await start();
		world.busy.add("ap-1");
		await autopilot.handleCommand(
			win,
			world.sidecars.get("ap-1") as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c", callerTabId: "ap-1", tag: "autopilot-child" }),
		).rejects.toThrow(/ending/);
	});

	it("■ aborts the running children, leaves the idle ones, and journals paused user_abort", async () => {
		await start();
		for (const tab of ["child-1", "child-2"]) {
			world.addTab(tab, path.join(tmp, tab));
			await autopilot.beforeFirstPrompt({ tabId: tab, callerTabId: "ap-1", tag: "autopilot-child" });
		}
		world.busy.add("child-1");
		await autopilot.aborted("ap-1");
		expect(world.stock("child-1", "abort")).toHaveLength(1);
		expect(world.stock("child-2", "abort")).toHaveLength(0);
		expect(world.stopped).toEqual(["child-1"]);
		const last = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1);
		expect(last?.params).toMatchObject({ state: "paused", reason: "user_abort" });
		expect(notices).toEqual([]);
	});

	it("the screen's ■ (set_autopilot abort) aborts the parent's turn through stock, then pauses as user_abort", async () => {
		const { sidecar } = await start();
		world.busy.add("ap-1");
		const response = await autopilot.handleCommand(
			win,
			sidecar as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "abort" },
			"abort-1",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		expect(world.stock("ap-1", "abort")).toHaveLength(1);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "user_abort",
		});
	});
});

describe("stop requests from the bridge", () => {
	it("a rule's pause becomes a stock pause plus a journaled reason, with a notice by kind", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "repo_gone", detail: "/x" });
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toEqual({ action: "pause" });
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "repo_gone",
		});
		expect(notices).toEqual([
			{ kind: "error", title: "Autopilot paused", body: "The repository folder is gone (/x)." },
		]);
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "budget" });
		await autopilot.idle();
		expect(notices.at(-1)?.kind).toBe("completion");
	});

	it("the user's own pause says nothing, and notify off silences everything", async () => {
		await start({ type: "set_autopilot", action: "start", notify: "off" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "ban_violation", detail: "x" });
		await autopilot.idle();
		expect(notices).toEqual([]);
		build();
		await start();
		const second = world.sidecars.get("ap-2") as unknown as SidecarLike;
		autopilot.frame(second, { type: "autopilot_stop_requested", reason: "user_pause" });
		await autopilot.idle();
		expect(notices).toEqual([]);
	});

	it("an end request winds the run down like a stop", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "agent_done", end: true });
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state)).toEqual([
			"stopping",
			"ended",
		]);
		expect(notices[0]?.body).toMatch(/declared the work done/);
	});
});

describe("a failed turn", () => {
	const failed = (message: string) => ({
		type: "idle" as const,
		tabId: "ap-1",
		outcome: { stopReason: "error", errorMessage: message },
	});

	it("asks for the next cycle once the retries leave nothing pending, and never pauses", async () => {
		await start();
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		expect(afters).toHaveLength(1);
		afters[0]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "prompt").at(-1)?.params).toMatchObject({ streamingBehavior: "followUp" });
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("waits while TurnResume holds a scheduled retry, or a turn is running again", async () => {
		await start();
		world.scheduled.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		afters[0]?.();
		await autopilot.idle();
		world.scheduled.delete("ap-1");
		world.busy.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		afters[1]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
	});

	it("leaves a usage limit to the renderer's reservation and other tabs alone", async () => {
		await start();
		autopilot.observeActivity(failed("429 usage limit reached, resets at 14:20"));
		expect(afters).toHaveLength(0);
		autopilot.observeActivity({ type: "idle", tabId: "elsewhere", outcome: { stopReason: "error" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: { stopReason: "stop" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: undefined });
		expect(afters).toHaveLength(0);
		expect(world.stock("ap-1", "set_goal")).toHaveLength(1);
	});

	it("does not pause a run that is already paused or stopping", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.state = "paused";
		autopilot.observeActivity(failed("boom"));
		afters[0]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal")).toHaveLength(1);
	});

	it("a released tab ends its run's bookkeeping", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		autopilot.observeActivity({ type: "released", tabId: "ap-1" });
		await autopilot.idle();
		expect(world.released).toEqual(["c1"]);
	});
});

describe("a cycle's end", () => {
	it("pushes the autopilot branch after a green cycle when auto push is on, and records the journal action first", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ commit: sha }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).not.toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/autopilot/2026-10-17"],
			sha,
		});
		const flags = world
			.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
			.map(call => call.params?.inFlight ?? null);
		expect(flags).toEqual([expect.objectContaining({ kind: "push" }), null]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params?.state).toBe("running");
	});

	it("does not push a red cycle, nor anything when auto push is off", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ verify: "red" }) });
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		build();
		await start({ type: "set_autopilot", action: "start", preset: "local" });
		await commit(path.join(tmp, "wt-2026-10-17-2"), "b.txt").catch(() => undefined);
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	it("a verified user push request pushes at the turn's end even with auto push off", async () => {
		await start();
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		world.requests.push({ kind: "push", quote: "push now", cycle: 1, at: 1 });
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ verify: "red" }),
		});
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
	});

	it("a refused push is reported to the agent and never pauses the run", async () => {
		gitSync(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		for (let cycle = 1; cycle <= 4; cycle++) {
			autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: cycle }) });
			await autopilot.idle();
		}
		const states = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state);
		expect(states).not.toContain("paused");
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/push of autopilot\/2026-10-17 failed.*never forces/,
		);
	});

	it("pauses with ban_violation when the cycle moved something it was not entitled to", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/autopilot/2026-10-17");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "ban_violation",
		});
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toEqual({ action: "pause" });
		expect(notices.at(-1)).toMatchObject({ kind: "error", title: "Autopilot paused" });
	});

	// What the guard cannot see (an obfuscated command), the audit still names: the moved ref is the detail.
	it.each([
		["a tag", (worktree: string) => gitSync(worktree, "tag", "stray-tag"), "refs/tags/stray-tag"],
		[
			"a push to another branch",
			(worktree: string) => gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/rogue"),
			"refs/remotes/origin/rogue",
		],
	])("names %s the cycle made behind the guard's back", async (_name, act, ref) => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		act(worktree);
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		const paused = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params;
		expect(paused).toMatchObject({ state: "paused", reason: "ban_violation" });
		expect(String((paused as { detail?: unknown } | undefined)?.detail ?? "")).toContain(ref);
	});

	it("a clean cycle is not a violation, and a second cycle is judged against the first's end", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await commit(worktree, "a.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record() });
		await autopilot.idle();
		await commit(worktree, "b.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("folds the children's usage into the cycle, closes their tabs and removes only clean merged worktrees", async () => {
		await start();
		const parent = path.join(tmp, "wt-2026-10-17");
		const merged = path.join(tmp, "child-merged");
		const unmerged = path.join(tmp, "child-unmerged");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/merged", merged, "autopilot/2026-10-17");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/unmerged", unmerged, "autopilot/2026-10-17");
		await commit(unmerged, "u.txt");
		for (const [tab, dir, branch] of [
			["child-1", merged, "omp/agent/merged"],
			["child-2", unmerged, "omp/agent/unmerged"],
		] as const) {
			world.addTab(tab, dir);
			await autopilot.beforeFirstPrompt({
				tabId: tab,
				callerTabId: "ap-1",
				tag: "autopilot-child",
				worktree: { path: dir, branch },
			});
		}
		world.stats.set("child-1", { tokens: { total: 1000 }, cost: 0.5 });
		world.stats.set("child-2", { tokens: { total: 250 }, cost: 0.25 });
		world.busy.add("child-2");
		await commit(parent, "p.txt");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ n: 4 }),
		});
		await autopilot.idle();
		expect(world.released.sort()).toEqual(["child-1", "child-2"]);
		expect(world.stock("child-2", "abort")).toHaveLength(1);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.cycleAmend)[0]?.params).toEqual({
			n: 4,
			tokens: 1250,
			usd: 0.75,
		});
		await expect(fs.stat(merged)).rejects.toThrow();
		await expect(fs.stat(unmerged)).resolves.toBeTruthy();
		expect(
			gitSync(main, "for-each-ref", "--format=%(refname:short)", "refs/heads/omp/agent").split("\n").sort(),
		).toEqual(["omp/agent/merged", "omp/agent/unmerged"]);
	});

	it("keeps a merged child's worktree when it has uncommitted changes", async () => {
		await start();
		const dir = path.join(tmp, "child-dirty");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/dirty", dir, "autopilot/2026-10-17");
		await fs.writeFile(path.join(dir, "README.md"), "dirty\n");
		world.addTab("child-1", dir);
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: dir, branch: "omp/agent/dirty" },
		});
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		await expect(fs.stat(dir)).resolves.toBeTruthy();
	});

	it("notifies every cycle only in cycles mode, and a red one as an error", async () => {
		await start({ type: "set_autopilot", action: "start", notify: "cycles" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2, title: "Fix it" }) });
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ n: 3, verify: "red", title: "Broke it" }),
		});
		await autopilot.idle();
		expect(notices).toEqual([
			{ kind: "completion", title: "Autopilot cycle 2 done", body: "Fix it" },
			{ kind: "error", title: "Autopilot cycle 3: checks red", body: "Broke it" },
		]);
		build();
		notices = [];
		await start();
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(notices).toEqual([]);
	});
});

describe("ship actions from the screen", () => {
	it("queues a revert for the cycle's commit and runs it at once between turns, then marks the cycle", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 5, commit: sha })];
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 5 },
			"9",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		await expect(fs.stat(path.join(worktree, "a.txt"))).rejects.toThrow();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.markReverted)[0]?.params).toEqual({ cycle: 5 });
	});

	it("a cycle end that outlives the next cycle's start pushes its own commit and leaves later items for that turn's end", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.now = { n: 2, startedAt: 1 };
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		clock.value = 20;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 1, commit: sha }) });
		clock.value = 30;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "pr" }, "1");
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		const queue = (await autopilot.status(sidecar, "ap-1")).ship?.queue ?? [];
		expect(queue.map(item => `${item.kind}:${item.state}`).sort()).toEqual(["pr:queued", "push:done"]);
		status.now = undefined;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect((await autopilot.status(sidecar, "ap-1")).ship?.queue.find(item => item.kind === "pr")?.state).toBe(
			"done",
		);
	});

	it("keeps two consecutive actions queued while the journal shows a cycle in flight, even if the pool says idle", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.now = { n: 2, startedAt: 1 };
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "push" }, "1");
		const second = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "pr" },
			"2",
		);
		await autopilot.idle();
		expect(dataOf<AutopilotStatus>(second).ship?.queue.map(item => [item.kind, item.state])).toEqual([
			["push", "queued"],
			["pr", "queued"],
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)).toHaveLength(0);
		status.now = undefined;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction).length).toBeGreaterThan(0);
	});

	it("holds an item queued while a turn runs and runs it at that turn's end", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 5, commit: sha })];
		world.busy.add("ap-1");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 5 },
			"9",
		);
		const queue = dataOf<AutopilotStatus>(response).ship?.queue;
		expect(queue).toEqual([expect.objectContaining({ kind: "revert", state: "queued", cycle: 5 })]);
		await expect(fs.stat(path.join(worktree, "a.txt"))).resolves.toBeTruthy();
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 6 }) });
		await autopilot.idle();
		await expect(fs.stat(path.join(worktree, "a.txt"))).rejects.toThrow();
	});

	it("refuses a revert of a cycle without a commit, and cancels a queued item", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 2 })];
		const refused = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 2 },
			"1",
		);
		expect(errorOf(refused)).toMatch(/no commit/);
		world.busy.add("ap-1");
		const queued = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "push" },
			"2",
		);
		const id = dataOf<AutopilotStatus>(queued).ship?.queue[0]?.id ?? "";
		const cancelled = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "cancel_ship", id },
			"3",
		);
		expect(dataOf<AutopilotStatus>(cancelled).ship?.queue).toEqual([]);
	});

	it("the auto toggles configure the bridge, and auto release needs a procedure", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "auto_push", enabled: true },
			"1",
		);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.configure).at(-1)?.params).toEqual({
			ship: { autoPush: true },
		});
		const refused = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "auto_release", enabled: true },
			"2",
		);
		expect(errorOf(refused)).toMatch(/release procedure/i);
	});

	it("Release sends the user's own words as a follow-up and shows a tracked item", async () => {
		build({ releaseProcedure: true });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "release" },
			"1",
		);
		expect(dataOf<AutopilotStatus>(response).ship?.queue).toEqual([
			expect.objectContaining({ kind: "release", state: "running" }),
		]);
		expect(world.stock("ap-1", "prompt")[0]?.params).toEqual({
			message: RELEASE_NOW_MESSAGE,
			streamingBehavior: "followUp",
		});
	});
});

describe("release run", () => {
	async function reported(): Promise<SidecarLike> {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({
				area: "release",
				ship: { kind: "release", version: "1.2.3", runUrl: "https://github.com/o/r/actions/runs/9" },
			}),
		});
		await autopilot.idle();
		return sidecar;
	}

	it("follows the run every 15 s and reports success", async () => {
		await reported();
		expect(world.releaseCalls("ap-1").at(-1)?.params).toEqual({
			release: { version: "1.2.3", runUrl: "https://github.com/o/r/actions/runs/9", state: "pending" },
		});
		expect(polls).toHaveLength(1);
		releaseState = { status: "in_progress", conclusion: null };
		polls[0]?.run();
		await autopilot.idle();
		expect(polls[0]?.stopped).toBe(false);
		releaseState = { status: "completed", conclusion: "success" };
		polls[0]?.run();
		await autopilot.idle();
		await autopilot.idle();
		expect(polls[0]?.stopped).toBe(true);
		expect(world.releaseCalls("ap-1").at(-1)?.params).toMatchObject({
			release: { state: "success" },
		});
		expect(notices.at(-1)).toEqual({
			kind: "completion",
			title: "Autopilot release",
			body: "Release 1.2.3 succeeded.",
		});
	});

	it("a failed run is reported and handed to the next cycle: the run is not paused", async () => {
		await reported();
		releaseState = { status: "completed", conclusion: "failure" };
		polls[0]?.run();
		await autopilot.idle();
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params?.state).not.toBe("paused");
		expect(notices.map(notice => notice.kind)).toContain("error");
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/release run of 1\.2\.3 failed/,
		);
		// The status the sheet shows keeps which release failed.
		expect(world.releaseCalls("ap-1").at(-1)?.params).toMatchObject({
			release: { version: "1.2.3", state: "failure" },
		});
	});

	it("a release without a run to watch is recorded as done", async () => {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ area: "release", ship: { kind: "release", version: "1.2.3" } }),
		});
		await autopilot.idle();
		expect(polls).toHaveLength(0);
		expect(world.releaseCalls("ap-1").at(-1)?.params).toEqual({
			release: { version: "1.2.3", state: "success" },
		});
	});

	it("opens the audit's release scope while auto release is on: the default branch push is no violation", async () => {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		gitSync(worktree, "push", "-q", "origin", "HEAD:main");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ area: "release" }),
		});
		await autopilot.idle();
		expect(
			world
				.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
				.some(call => call.params?.reason === "ban_violation"),
		).toBe(false);
	});
});

describe("status overlay", () => {
	it("adds the live children and the ship queue to the bridge's update, for a run only", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.addTab("child-1", path.join(tmp, "c"));
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c"), branch: "omp/agent/c" },
		});
		world.busy.add("child-1");
		const base = world.statuses.get("ap-1") as AutopilotStatus;
		const frame = { type: "autopilot_update", status: base };
		const out = autopilot.overlay(sidecar, frame) as { status: AutopilotStatus };
		expect(out.status.children).toEqual([{ tabId: "child-1", branch: "omp/agent/c", status: "running" }]);
		expect(out.status.ship?.queue).toEqual([]);
		expect(autopilot.overlay(world.addTab("other", main), frame)).toBe(frame);
		const inactive = { type: "autopilot_update", status: { active: false } };
		expect(autopilot.overlay(sidecar, inactive)).toBe(inactive);
	});

	it("asks the bridge to re-emit after a child opens", async () => {
		await start();
		const before = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.configure).length;
		world.addTab("child-1", path.join(tmp, "c"));
		await autopilot.beforeFirstPrompt({ tabId: "child-1", callerTabId: "ap-1", tag: "autopilot-child" });
		await autopilot.idle();
		const emptied = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.configure).slice(before);
		expect(emptied.length).toBeGreaterThan(0);
		expect(emptied.every(call => Object.keys(call.params ?? {}).length === 0)).toBe(true);
	});
});

describe("children", () => {
	it("arms a tagged child before its first prompt with a local-only policy, and ignores other sessions", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "release" }).catch(() => undefined);
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const parentTab = [...world.sidecars.keys()].find(tab => tab.startsWith("ap-")) ?? "ap-1";
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "c1",
			callerTabId: parentTab,
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/c1" },
		});
		const arm = world.bridgeCalls("c1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params as unknown as AutopilotArmParams;
		expect(arm).toMatchObject({ role: "child", root: path.join(tmp, "c1"), parentTab, branch: "omp/agent/c1" });
		expect(arm.settings.ship).toEqual({ ...DEFAULT_SHIP_POLICY, remote: "origin" });
		expect(arm.settings.limits).toEqual({ tokens: null, minutes: null, cycles: null, usd: null });
		// A session some other tab opened is none of the run's business.
		world.addTab("plain", main);
		await autopilot.beforeFirstPrompt({ tabId: "plain", callerTabId: "somebody-else" });
		expect(world.bridgeCalls("plain", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		// The tool path (`ompdesk_session_open`) passes no tag: whatever the run's tab opens is its child.
		world.addTab("untagged", path.join(tmp, "u"));
		await autopilot.beforeFirstPrompt({ tabId: "untagged", callerTabId: parentTab });
		expect(world.bridgeCalls("untagged", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			role: "child",
			parentTab,
		});
	});

	it("allows no more parallel children than the run's setting", async () => {
		await start({ type: "set_autopilot", action: "start", maxParallel: 1 });
		for (const tab of ["c1", "c2"]) world.addTab(tab, path.join(tmp, tab));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c2", callerTabId: "ap-1", tag: "autopilot-child" }),
		).rejects.toThrow(/at most 1/);
	});

	it("refuses a tagged child whose parent is no run", async () => {
		world.addTab("c1", main);
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "nobody", tag: "autopilot-child" }),
		).rejects.toThrow();
	});

	it("closes the children when the parent tab goes away", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		autopilot.tabReleased("ap-1");
		await Promise.resolve();
		expect(world.released).toEqual(["c1"]);
		expect(autopilot.isStopping("ap-1")).toBe(false);
	});
});

describe("approval cards", () => {
	const card = (title: string): ExtensionUIRequest => ({
		type: "extension_ui_request",
		id: "r1",
		method: "select",
		title: `Allow tool: ${title}`,
		options: ["Approve", "Deny"],
	});

	it("answers a run's cards (Deny for a violation), a child's cards by the child's rules, and leaves other tabs", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "c1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/c1" },
		});
		autopilot.attachSidecar("c1", world.sidecars.get("c1") as unknown as SidecarLike);
		world.sidecars.get("ap-1")?.emit("extensionUi", card("bash\nbun run check:changed"));
		world.sidecars.get("ap-1")?.emit("extensionUi", { ...card("bash\ngit push --force origin main"), id: "r2" });
		world.sidecars.get("c1")?.emit("extensionUi", { ...card("bash\ngit push origin HEAD"), id: "r3" });
		await autopilot.idle();
		expect(
			world.answers.map(entry => [entry.id, entry.tab, "value" in entry.response ? entry.response.value : ""]),
		).toEqual([
			["r1", "ap-1", "Approve"],
			["r2", "ap-1", "Deny"],
			["r3", "c1", "Deny"],
		]);
	});
});

describe("restart", () => {
	/** A process that came up with the run `running` in the journal and stock's goal paused. */
	async function relaunched(relaunch: RelaunchContinuation, branch = "autopilot/2026-10-17"): Promise<FakeSidecar> {
		build({ relaunch });
		const sidecar = world.addTab("t1", path.join(tmp, "wt-restart"));
		world.statuses.set("t1", {
			active: true,
			state: "running",
			role: "parent",
			run: "2026-10-17",
			root: path.join(tmp, "wt-restart"),
			branch,
			baseBranch: "main",
			cycle: 3,
			settings: startSettings({}, {}),
			cycles: [],
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [] },
		});
		const exists = gitSync(main, "branch", "--list", branch) !== "";
		gitSync(
			main,
			"worktree",
			"add",
			"-q",
			...(exists ? [] : ["-b"]),
			...(exists ? [path.join(tmp, "wt-restart"), branch] : [branch, path.join(tmp, "wt-restart")]),
		);
		autopilot.attachSidecar("t1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await autopilot.idle();
		return sidecar;
	}

	/** Stock's goal pause first (it forgets the tool set it reattached with), then arm with resume, then the resume. */
	function expectContinued(): void {
		const steps = world
			.names("t1")
			.filter(
				name =>
					name === AUTOPILOT_BRIDGE_METHODS.arm ||
					name === "set_goal" ||
					name === AUTOPILOT_BRIDGE_METHODS.setState,
			);
		expect(steps).toEqual(["set_goal", AUTOPILOT_BRIDGE_METHODS.arm, "set_goal"]);
		expect(world.stock("t1", "set_goal").map(call => call.params)).toEqual([
			{ action: "pause" },
			{ action: "resume" },
		]);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			resume: true,
			role: "parent",
		});
	}

	it("a run on a branch the user picked goes on on that branch: the journal's branch is what is armed and pushed to", async () => {
		gitSync(main, "branch", "feature/x");
		gitSync(main, "push", "-q", "origin", "feature/x");
		const sidecar = await relaunched("now", "feature/x");
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			branch: "feature/x",
			root: path.join(tmp, "wt-restart"),
			baseBranch: "main",
		});
		// The adopted run pushes that branch, not an `autopilot/` one.
		const sha = await commit(path.join(tmp, "wt-restart"), "after-restart.txt");
		world.requests.push({ kind: "push", quote: "push now", cycle: 4, at: 1 });
		autopilot.frame(sidecar as unknown as SidecarLike, { type: "autopilot_cycle_end", record: record({ n: 4 }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	it("without a launch marker (a kill between turns) the run goes on at once", async () => {
		await relaunched("now");
		expectContinued();
		expect(notices).toEqual([]);
	});

	it("a readiness judged before TurnResume's marker was in place continues once, even when resumeGoal follows", async () => {
		await relaunched("now");
		await autopilot.resumeGoal("t1");
		autopilot.resumeSettled("t1", "resumed");
		await autopilot.idle();
		expectContinued();
	});
	it("with Continue interrupted work off the run is paused with app_closed and nothing resumes by itself", async () => {
		await relaunched("off");
		expect(world.stock("t1", "set_goal").map(call => call.params?.action)).toEqual(["pause"]);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "app_closed",
		});
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		expect(notices).toEqual([]);
	});

	it("Resume continues a run paused as app_closed: arm again with resume, then stock's goal resume", async () => {
		const sidecar = await relaunched("off");
		const response = await autopilot.handleCommand(
			win,
			sidecar as unknown as SidecarLike,
			"t1",
			{ type: "set_autopilot", action: "resume" },
			"resume-1",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm).at(-1)?.params).toMatchObject({
			resume: true,
			role: "parent",
		});
		expect(world.stock("t1", "set_goal").map(call => call.params?.action)).toEqual(["pause", "resume"]);
	});

	it("with a marker the run waits for TurnResume, whose goal resume pauses, arms again, then resumes", async () => {
		await relaunched("after_restore");
		expect(world.stock("t1", "set_goal")).toHaveLength(0);
		await autopilot.resumeGoal("t1");
		autopilot.resumeSettled("t1", "resumed");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("arms again once even when TurnResume's goal resume comes before the readiness check has adopted the run", async () => {
		build({ relaunch: "after_restore" });
		const sidecar = world.addTab("t1", path.join(tmp, "wt-restart"));
		world.statuses.set("t1", {
			active: true,
			state: "running",
			role: "parent",
			run: "2026-10-17",
			root: path.join(tmp, "wt-restart"),
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			cycle: 3,
			settings: startSettings({}, {}),
			cycles: [],
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [] },
		});
		gitSync(main, "worktree", "add", "-q", "-b", "autopilot/2026-10-17", path.join(tmp, "wt-restart"));
		autopilot.attachSidecar("t1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await autopilot.resumeGoal("t1");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("a launch continuation that ends without resuming the goal still continues the run", async () => {
		await relaunched("after_restore");
		autopilot.resumeSettled("t1", "none");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("the user's Stop on the Continuing toast leaves the run paused with app_closed", async () => {
		await relaunched("after_restore");
		autopilot.resumeSettled("t1", "cancelled");
		await autopilot.idle();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			reason: "app_closed",
		});
	});

	it("a goal stock cannot resume shows the run paused with app_closed, and TurnResume hears of the failure", async () => {
		await relaunched("after_restore");
		world.failGoalResume = true;
		await expect(autopilot.resumeGoal("t1")).rejects.toThrow(/No paused goal/);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "app_closed",
		});
	});

	it("resumeGoal on a tab that is no run is stock's own resume", async () => {
		world.addTab("plain", main);
		await autopilot.resumeGoal("plain");
		expect(world.stock("plain", "set_goal")[0]?.params).toEqual({ action: "resume" });
		expect(world.names("plain", "bridge")).not.toContain(AUTOPILOT_BRIDGE_METHODS.arm);
	});

	it("does not adopt a child session or a finished run", async () => {
		build();
		const child = world.addTab("kid", main);
		world.statuses.set("kid", {
			active: true,
			state: "running",
			role: "child",
			root: main,
			branch: "x",
			settings: startSettings({}, {}),
		});
		autopilot.attachSidecar("kid", child as unknown as SidecarLike);
		child.emit("status", { status: "ready" });
		await autopilot.idle();
		expect(world.stock("kid", "set_goal")).toHaveLength(0);
		const done = world.addTab("done", main);
		world.statuses.set("done", {
			active: true,
			state: "ended",
			role: "parent",
			root: main,
			branch: "x",
			settings: startSettings({}, {}),
		});
		autopilot.attachSidecar("done", done as unknown as SidecarLike);
		done.emit("status", { status: "ready" });
		await autopilot.idle();
		expect(world.stock("done", "set_goal")).toHaveLength(0);
	});
});

/** A response's `data` as the type the command is documented to answer (the fake bridge's own shapes; nothing external). */
function dataOf<T>(response: RpcResponse): T {
	return response.data as T;
}

function errorOf(response: RpcResponse): string | undefined {
	return response.success ? undefined : response.error;
}
