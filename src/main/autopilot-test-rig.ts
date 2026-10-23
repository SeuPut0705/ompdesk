/**
 * The world the Autopilot coordinator tests share (never imported by app code): a repository with its bare remote,
 * a fake pool, bridge and sidecars, and an `Autopilot` wired to them. The tests are split over several files so they
 * run side by side: each runs real git many times, and on a Windows runner the one file took 203 s.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotArmParams,
	type AutopilotBranchChoice,
	type AutopilotCycleRecord,
	type AutopilotStatus,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { Autopilot, type AutopilotNotice, type AutopilotPool, type RepoProbe } from "./autopilot";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { gitSync, initRepoWithRemote } from "./local/git/test-repos";
import { createWorktree } from "./local/git/worktree";
import { detectReleaseProcedure } from "./release-detect";
import type { SidecarLike } from "./sidecar-types";
import type { RelaunchContinuation } from "./turn-resume";
import type { ClientWindow } from "./web/client-window";

// A start runs real git processes (branch facts, worktree, push target); on a loaded Windows runner one test
// crossed vitest's 5 s once (win-platform run 39111794694: "is not a run when the goal cannot be created").
vi.setConfig({ testTimeout: 30_000 });

export interface Call {
	tab: string;
	kind: "bridge" | "stock";
	name: string;
	params?: Record<string, unknown>;
}

export class FakeSidecar extends EventEmitter {
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
export class World {
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
	/** What the bridge answers `modes.autopilot_guide` with; unset: an agent's own text as it came, else no guide. */
	guide: unknown = undefined;
	/** Stock's session name per tab (`set_session_name` / `get_state`). */
	sessionNames = new Map<string, string>();
	/** What the windows were told the session is called (`noteSessionName`). */
	shownNames = new Map<string, string>();
	/** What stock's `get_usage` answers (`reports`). */
	usage: Array<{ provider: string; fetchedAt: number; limits: never[]; resetAt?: number }> = [];

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
		if (type === "get_state")
			return ok({ sessionName: this.sessionNames.get(tab) ?? null, model: { provider: "anthropic", id: "m" } });
		if (type === "get_usage") return ok({ reports: this.usage });
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
				// As the bridge's `nextStateEntry`: a change that names no state keeps the journal's state and reason.
				if (current && params.state !== undefined) {
					current.state = params.state as AutopilotStatus["state"];
					current.reason = params.reason as AutopilotStatus["reason"];
					current.detail = params.detail as string | undefined;
					current.quotaResetAt = params.quotaResetAt as number | undefined;
				}
				if (current) {
					if ("inFlight" in params && current.ship) {
						current.ship.inFlight = (params.inFlight as never) ?? undefined;
					}
				}
				return current;
			}
			case AUTOPILOT_BRIDGE_METHODS.guide:
				return (
					this.guide ??
					(typeof params.text === "string"
						? { text: params.text, source: "given", release: "kept", releases: false }
						: null)
				);
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

export let tmp = "";
export let main = "";
export let remote = "";
export let world: World;
export let notices: AutopilotNotice[];
export let endedRoots: string[];
/** The run summaries written to the runtime log (`runLog`). */
export let runLogs: Array<{ message: string; details: Record<string, string | number | boolean> }>;
export let polls: Array<{ run: () => void; stopped: boolean }>;
export let afters: Array<() => void>;
export let releaseState: { status: string; conclusion: string | null } | null;
export let autopilot: Autopilot;
export let nextTab = 0;
export const clock = { value: 1_000 };
export const win = {} as ClientWindow;

export function text(key: MainTextKey, params?: Record<string, string | number>): string {
	return MAIN_TEXT[key].en.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in (params ?? {}) ? String(params?.[name]) : match,
	);
}

export function build(
	over: {
		releaseProcedure?: boolean;
		/** The real detection over the run's checkout (the committed guide's Release section counts). */
		realDetect?: boolean;
		relaunch?: RelaunchContinuation;
		prefs?: Record<string, unknown>;
		probeRepo?: (root: string) => Promise<RepoProbe>;
	} = {},
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
		runEnded: root => {
			endedRoots.push(root);
		},
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
		detectRelease: over.realDetect
			? detectReleaseProcedure
			: async () => (over.releaseProcedure ? { file: "AGENTS.md", anchors: ["Release"] } : null),
		log: () => undefined,
		runLog: (message, details) => {
			runLogs.push({ message, details });
		},
		...(over.probeRepo ? { probeRepo: over.probeRepo } : {}),
	});
	autopilot.attachControl({ childrenOf: () => [], clearQueue: async () => undefined });
}

export async function start(
	options: Parameters<Autopilot["handleCommand"]>[3] = { type: "set_autopilot", action: "start" },
) {
	const sidecar = world.addTab("parent", main);
	autopilot.attachSidecar("parent", sidecar as unknown as SidecarLike);
	const response = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "parent", options, "1");
	return { response, sidecar };
}

export const record = (over: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord => ({
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

export async function commit(cwd: string, name: string): Promise<string> {
	await fs.writeFile(path.join(cwd, name), name);
	gitSync(cwd, "add", name);
	gitSync(cwd, "commit", "-q", "-m", name);
	return gitSync(cwd, "rev-parse", "HEAD");
}

/** Registers the shared hooks: one repository and its bare remote, copied fresh for each test. */
export function installAutopilotRig(): void {
	// One repository with its bare remote, built once and copied for each test.
	let template = "";
	beforeAll(async () => {
		template = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-template-")));
		await initRepoWithRemote(path.join(template, "main"), path.join(template, "remote.git"));
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
		endedRoots = [];
		runLogs = [];
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
}

/** Replaces what the fake GitHub run answers (`ghRun`). */
export function setReleaseState(state: { status: string; conclusion: string | null } | null): void {
	releaseState = state;
}

/** A response's `data` as the type the command is documented to answer (the fake bridge's own shapes; nothing external). */
export function dataOf<T>(response: RpcResponse): T {
	return response.data as T;
}

export function errorOf(response: RpcResponse): string | undefined {
	return response.success ? undefined : response.error;
}

// The branches a run can be put on (autopilot-branch-*.test.ts): helpers and a repository with `feature/x` on both
// sides and `remote-only` on the remote alone.
export function branchChoiceWorld() {
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

	return { startOn, rootOf, refusal, armed, cycleEnd };
}
