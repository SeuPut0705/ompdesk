/**
 * The updater's rules, with fake detection, a fake check and a fake installer: only installed tools are listed
 * and updated, check → update → re-detect, current tools are left alone, a running Node CLI's update waits on
 * macOS but a Windows lock is only a recorded failure, failures back off, skipped copies carry their reason,
 * the pref gates scheduled passes but not "Update now", and the IPC carries ids only.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolId, CliUpdateState } from "../../shared/cli-update";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { CHECK_INTERVAL_MS } from "../omp-updater";
import type { ToolUpdateOutcome, ToolUpdateRequest } from "../setup/service";
import type { CliDetection, CliOwner, DetectDeps } from "./detect";
import { CliUpdater, type CliUpdaterDeps, registerCliUpdateIpc } from "./updater";

const NPM: CliOwner = { method: "npm", name: "@openai/codex", prefix: "/p", root: "/p/lib/node_modules/@openai/codex" };

function codex(over: Partial<CliDetection> = {}): CliDetection {
	return {
		id: "codex",
		path: "/p/bin/codex",
		real: "/p/lib/node_modules/@openai/codex/bin/codex.js",
		owner: NPM,
		skip: null,
		installed: "0.50.1",
		...over,
	};
}

interface Harness {
	updater: CliUpdater;
	states: CliUpdateState[];
	/** What `detect` answers per tool; a test changes it to model an install. */
	detections: Partial<Record<CliToolId, CliDetection | null>>;
	providers: { value: string[] | Error };
	checks: string[][];
	latest: { value: string | Error };
	updates: ToolUpdateRequest[];
	outcome: { value: ToolUpdateOutcome; onRun?: () => void };
	processes: { value: string };
	clock: { now: number };
	pref: { enabled: boolean };
}

function harness(over: Partial<CliUpdaterDeps> = {}, scheduled = true): Harness {
	const h: Harness = {
		updater: undefined as unknown as CliUpdater,
		states: [],
		detections: { codex: codex() },
		providers: { value: ["openai-codex"] },
		checks: [],
		latest: { value: "0.51.0" },
		updates: [],
		outcome: { value: { kind: "succeeded" } },
		processes: { value: "" },
		clock: { now: 1_000_000 },
		pref: { enabled: true },
	};
	h.updater = new CliUpdater({
		scheduled,
		enabled: () => h.pref.enabled,
		platform: "darwin",
		toolsDir: "/tools",
		connectedProviders: async () => {
			if (h.providers.value instanceof Error) throw h.providers.value;
			return h.providers.value;
		},
		env: async () => ({ PATH: "/nowhere" }),
		testInstaller: "/fake/installer",
		managedLatest: async () => "2.99.0",
		runUpdate: async request => {
			h.updates.push(request);
			h.outcome.onRun?.();
			return h.outcome.value;
		},
		processes: async () => h.processes.value,
		onState: state => h.states.push(state),
		now: () => h.clock.now,
		detect: async (id: CliToolId, _deps: DetectDeps) => h.detections[id] ?? null,
		runCheck: async command => {
			h.checks.push([command.spawn.file, ...command.spawn.args]);
			if (h.latest.value instanceof Error) throw h.latest.value;
			return `${h.latest.value}\n`;
		},
		...over,
	});
	return h;
}

const tool = (h: Harness, id: CliToolId) => h.updater.state().tools.find(entry => entry.id === id);

afterEach(() => {
	vi.useRealTimers();
});

describe("CliUpdater", () => {
	it("lists only installed tools of the connected providers, plus machine setup's, and installs nothing", async () => {
		const h = harness({}, false);
		h.providers.value = ["openai-codex", "anthropic"];
		h.detections.gh = {
			id: "gh",
			path: "/opt/homebrew/bin/gh",
			real: "/opt/homebrew/Cellar/gh/2.96.0/bin/gh",
			owner: { method: "brew", name: "gh", brew: "/opt/homebrew/bin/brew" },
			skip: null,
			installed: "2.96.0",
		};
		// claude is connected but not installed: it is not listed, and nothing runs for it.
		h.updater.start();
		await h.updater.rescan();
		expect(h.updater.state().tools.map(entry => entry.id)).toEqual(["codex", "gh"]);
		expect(tool(h, "codex")).toMatchObject({
			providers: ["openai-codex"],
			installed: "0.50.1",
			method: "npm",
			skip: null,
			phase: "idle",
			last: null,
		});
		expect(tool(h, "gh")).toMatchObject({ providers: [], method: "brew" });
		expect(h.updates).toEqual([]);
		expect(h.checks).toEqual([]);
	});

	it("still lists machine setup's tools when the provider list cannot be read", async () => {
		const h = harness({}, false);
		h.providers.value = new Error("omp is not installed");
		h.detections = {
			node: { ...codex({ id: "node", installed: "24.11.0" }), owner: { method: "managed", item: "node" } },
		};
		h.updater.start();
		await h.updater.rescan();
		expect(h.updater.state().tools.map(entry => entry.id)).toEqual(["node"]);
	});

	it("checks, updates through the setup supervisor and detects again: codex 0.50.1 → 0.51.0", async () => {
		const h = harness();
		h.outcome.onRun = () => {
			h.detections.codex = codex({ installed: "0.51.0" });
		};
		await h.updater.updateNow("codex");
		// The fake installer is asked for the newest version with the tool and its method.
		expect(h.checks).toEqual([["/fake/installer", "cli-codex", "npm", "check"]]);
		expect(h.updates).toEqual([{ tool: "codex", method: "npm", spawn: null, env: {} }]);
		expect(tool(h, "codex")).toMatchObject({
			phase: "idle",
			installed: "0.51.0",
			latest: "0.51.0",
			last: { kind: "updated", from: "0.50.1", to: "0.51.0" },
		});
		// The phases the UI shows, in order.
		const phases = h.states.map(state => state.tools.find(entry => entry.id === "codex")?.phase);
		expect(phases).toContain("checking");
		expect(phases).toContain("updating");
		expect(phases.at(-1)).toBe("idle");
	});

	it("leaves a current tool alone", async () => {
		const h = harness();
		h.latest.value = "0.50.1";
		await h.updater.updateNow("codex");
		expect(h.updates).toEqual([]);
		expect(tool(h, "codex")).toMatchObject({ last: { kind: "current" }, latest: "0.50.1" });
	});

	it("compares versions as numbers: 0.9.0 installed is older than 0.10.0", async () => {
		const h = harness();
		h.detections.codex = codex({ installed: "0.9.0" });
		h.latest.value = "0.10.0";
		await h.updater.updateNow("codex");
		expect(h.updates).toHaveLength(1);
		const newer = harness();
		newer.detections.codex = codex({ installed: "0.10.0" });
		newer.latest.value = "0.9.0";
		await newer.updater.updateNow("codex");
		expect(newer.updates).toEqual([]);
		expect(tool(newer, "codex")?.last).toEqual({ kind: "current" });
	});

	it("on macOS waits while the Node CLI runs, and updates at the next check after it quits", async () => {
		const h = harness();
		h.processes.value = "node /p/lib/node_modules/@openai/codex/bin/codex.js --model gpt-5\n";
		await h.updater.updateNow("codex");
		expect(h.updates).toEqual([]);
		expect(tool(h, "codex")).toMatchObject({ last: { kind: "deferred", latest: "0.51.0" }, installed: "0.50.1" });
		// A deferral is no failure: no back-off.
		h.processes.value = "/sbin/launchd\n";
		h.outcome.onRun = () => {
			h.detections.codex = codex({ installed: "0.51.0" });
		};
		await h.updater.updateNow("codex");
		expect(h.updates).toHaveLength(1);
		expect(tool(h, "codex")?.last).toMatchObject({ kind: "updated", to: "0.51.0" });
	});

	it("never defers an update the vendor's own updater runs (a single binary keeps its old inode)", async () => {
		const h = harness();
		h.detections = {
			claude: {
				...codex({
					id: "claude",
					path: "/u/.local/bin/claude",
					real: "/u/.local/share/claude/v1",
					installed: "2.0.1",
				}),
				owner: { method: "self" },
			},
		};
		h.providers.value = ["anthropic"];
		h.latest.value = "2.1.0";
		h.processes.value = "/u/.local/bin/claude --resume\n";
		await h.updater.updateNow("claude");
		expect(h.updates).toHaveLength(1);
		expect(h.updates[0]).toMatchObject({ tool: "claude", method: "self" });
	});

	it("on Windows a locked file is only a recorded failure that the next scheduled check retries", async () => {
		const h = harness({ platform: "win32" });
		h.processes.value = "codex.exe\n";
		h.outcome.value = { kind: "failed", detail: "exit 1 — EBUSY: resource busy or locked" };
		await h.updater.updateNow("codex");
		expect(h.updates).toHaveLength(1);
		expect(tool(h, "codex")?.last).toEqual({
			kind: "failed",
			failure: { reason: "install", detail: "exit 1 — EBUSY: resource busy or locked" },
		});
		// Scheduled passes honor the back-off: 4 h × 2 after one failure.
		h.updater.start();
		await h.updater.rescan();
		h.updates.length = 0;
		h.clock.now += CHECK_INTERVAL_MS;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.updates).toEqual([]);
		h.clock.now += CHECK_INTERVAL_MS;
		h.outcome.value = { kind: "succeeded" };
		h.outcome.onRun = () => {
			h.detections.codex = codex({ installed: "0.51.0" });
		};
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.updates).toHaveLength(1);
		expect(tool(h, "codex")?.last).toMatchObject({ kind: "updated", to: "0.51.0" });
	});

	it("records a failed check, a failed or cancelled update and an update that left the old version", async () => {
		const h = harness();
		h.latest.value = new Error("npm ERR! network request failed");
		await h.updater.updateNow("codex");
		expect(tool(h, "codex")?.last).toEqual({
			kind: "failed",
			failure: { reason: "check", detail: "npm ERR! network request failed" },
		});
		h.latest.value = "0.51.0";
		h.outcome.value = { kind: "cancelled" };
		await h.updater.updateNow("codex");
		expect(tool(h, "codex")?.last).toEqual({ kind: "failed", failure: { reason: "cancelled" } });
		h.outcome.value = { kind: "succeeded" };
		await h.updater.updateNow("codex");
		expect(tool(h, "codex")?.last).toEqual({ kind: "failed", failure: { reason: "not-updated" } });
		expect(tool(h, "codex")).toMatchObject({ installed: "0.50.1", phase: "idle" });
	});

	it("skips a system, bundled or admin-owned copy with its reason, and never checks or updates it", async () => {
		const h = harness();
		h.detections.codex = codex({
			path: "/Applications/ChatGPT.app/Contents/Resources/codex",
			real: "/Applications/ChatGPT.app/Contents/Resources/codex",
			owner: null,
			skip: "bundled",
			installed: "0.46.0",
		});
		await h.updater.updateNow();
		expect(tool(h, "codex")).toMatchObject({ skip: "bundled", method: null, installed: "0.46.0", last: null });
		expect(h.checks).toEqual([]);
		expect(h.updates).toEqual([]);
		h.detections.codex = codex({ owner: null, skip: "not-writable" });
		await h.updater.updateNow("codex");
		expect(tool(h, "codex")).toMatchObject({ skip: "not-writable" });
		expect(h.updates).toEqual([]);
	});

	it("lets the tool's own updater decide when it has no registry to ask (Cursor Agent)", async () => {
		const h = harness();
		h.providers.value = ["cursor"];
		h.detections = {
			"cursor-agent": {
				id: "cursor-agent",
				path: "/u/.local/bin/cursor-agent",
				real: "/u/.local/share/cursor-agent/v1/cursor-agent",
				owner: { method: "self" },
				skip: null,
				installed: "2026.01.01",
			},
		};
		// The fake installer answers its check with nothing newer, so the tool's own `update` is the check.
		h.latest.value = "2026.01.01";
		await h.updater.updateNow("cursor-agent");
		expect(h.updates).toEqual([]);
		expect(tool(h, "cursor-agent")?.last).toEqual({ kind: "current" });
	});

	it("asks the real owner's check when no installer is set, and updates machine setup's copy through its archive", async () => {
		const prefix = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-updater-")));
		try {
			await fs.mkdir(path.join(prefix, "bin"));
			await fs.writeFile(path.join(prefix, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
			const owner: CliOwner = { ...NPM, prefix, root: `${prefix}/lib/node_modules/@openai/codex` };
			const h = harness({ testInstaller: null });
			h.detections.codex = codex({ owner });
			await h.updater.updateNow("codex");
			expect(h.checks).toEqual([[path.join(prefix, "bin", "npm"), "view", "@openai/codex", "version"]]);
			expect(h.updates).toHaveLength(1);
			expect(h.updates[0]?.spawn).toMatchObject({
				file: path.join(prefix, "bin", "npm"),
				args: ["install", "-g", "--prefix", prefix, "@openai/codex@0.51.0"],
			});

			const managed = harness({ testInstaller: null });
			managed.providers.value = [];
			managed.detections = {
				gh: { ...codex({ id: "gh", installed: "2.90.0" }), owner: { method: "managed", item: "gh" } },
			};
			await managed.updater.updateNow("gh");
			expect(managed.checks).toEqual([]);
			expect(managed.updates).toEqual([{ tool: "gh", method: "managed", spawn: null, managed: "gh", env: {} }]);
		} finally {
			await fs.rm(prefix, { recursive: true, force: true });
		}
	});

	it("checks scheduled passes only while the pref is on, lists tools either way, and 'Update now' ignores the pref", async () => {
		const h = harness();
		h.pref.enabled = false;
		h.updater.start();
		await h.updater.rescan();
		expect(h.updater.state()).toMatchObject({ enabled: false, scheduled: true });
		expect(h.updater.state().tools).toHaveLength(1);
		expect(h.checks).toEqual([]);
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.checks).toEqual([]);
		h.latest.value = "0.50.1";
		await h.updater.updateNow("codex");
		expect(h.checks).toHaveLength(1);
		// Turning it on checks right away.
		h.pref.enabled = true;
		h.latest.value = "0.50.1";
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.checks).toHaveLength(2);
	});

	it("runs on the 4 h cadence from launch", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.latest.value = "0.50.1";
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.checks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(h.checks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.checks).toHaveLength(2);
		h.updater.dispose();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.checks).toHaveLength(2);
	});

	it("a launch that does not schedule (a dev or test build) lists tools but checks only on request", async () => {
		const h = harness({}, false);
		h.updater.start();
		await h.updater.rescan();
		expect(h.checks).toEqual([]);
		expect(h.updater.state().scheduled).toBe(false);
		await h.updater.updateNow();
		expect(h.checks).toHaveLength(1);
	});
});

describe("registerCliUpdateIpc", () => {
	function register() {
		const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const updater = {
			state: vi.fn(() => ({ enabled: true, scheduled: true, tools: [] }) as CliUpdateState),
			updateNow: vi.fn(async (_id?: CliToolId) => {}),
			rescan: vi.fn(async () => {}),
		};
		registerCliUpdateIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, updater);
		return { handlers, updater };
	}

	it("serves the snapshot (and looks for newly installed tools) without taking an argument", () => {
		const { handlers, updater } = register();
		const state = handlers.get(IPC_COMMANDS.CLI_UPDATE_GET_STATE)?.({});
		expect(state).toEqual({ enabled: true, scheduled: true, tools: [] });
		expect(updater.rescan).toHaveBeenCalledTimes(1);
	});

	it("takes a tool id or nothing for 'Update now', and refuses anything else", () => {
		const { handlers, updater } = register();
		const now = handlers.get(IPC_COMMANDS.CLI_UPDATE_NOW);
		now?.({}, "codex");
		now?.({});
		expect(updater.updateNow.mock.calls).toEqual([["codex"], [undefined]]);
		for (const bad of ["rm -rf /", "/usr/bin/codex", "codex --version", 5, { id: "codex" }]) {
			expect(() => now?.({}, bad)).toThrow(/Unknown tool/);
		}
		expect(updater.updateNow).toHaveBeenCalledTimes(2);
	});
});
