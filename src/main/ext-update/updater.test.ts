/**
 * The updater's rules, with a fake stock helper, a fake installer and fake processes: what each kind of row
 * does (marketplace refresh, plugin check → upgrade, skill check → update, MCP owner check → update → read
 * the version again, a pinned runner package checked and never changed), the order of a pass, the one apply
 * call at its end, pins that no call can move, the running rule, back-off per row, omp-busy, and the pref.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EXTENSION_HELPER_METHODS,
	type HelperInventory,
	type HelperMcpServer,
	type HelperPlugin,
	type HelperRegistrySkill,
	type PluginCheckResult,
	type PluginUpgradeResult,
	type SkillCheckResult,
	type SkillUpdateResult,
} from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import type { ExtensionRow, ExtensionUpdateState } from "../../shared/extension-update";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { ExtensionApplyPlan } from "../extension-reload";
import type { ToolUpdateOutcome, ToolUpdateRequest } from "../setup/service";
import { CHECK_INTERVAL_MS, nextCheckDelay, UPDATE_STEP_MAX_MS } from "../update-scheduler";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { registerExtensionUpdateIpc } from "./ipc";
import type { McpBinary, McpOwner } from "./mcp-owner";
import { ExtensionUpdater, type ExtensionUpdaterDeps } from "./updater";

const NPM: McpOwner = { method: "npm", name: "@s/pkg", prefix: "/p", root: "/p/lib/node_modules/@s/pkg" };

function binary(over: Partial<McpBinary> = {}, owner: McpOwner | null = NPM): McpBinary {
	return {
		command: "pkg",
		path: "/p/bin/pkg",
		real: "/p/lib/node_modules/@s/pkg/bin/cli.js",
		owner,
		skip: null,
		installed: "1.0.0",
		script: true,
		...over,
	};
}

const server = (
	name: string,
	command: string,
	args: string[] = [],
	over: Partial<HelperMcpServer> = {},
): HelperMcpServer => ({
	name,
	type: "stdio",
	command,
	args,
	url: null,
	enabled: true,
	sourcePath: "/home/u/.omp/agent/mcp.json",
	origin: "user",
	...over,
});

const plugin = (over: Partial<HelperPlugin> = {}): HelperPlugin => ({
	channel: "marketplace",
	id: "tools@official",
	scope: "user",
	cwd: null,
	installed: "1.0.0",
	spec: null,
	enabled: true,
	...over,
});

const skill = (over: Partial<HelperRegistrySkill> = {}): HelperRegistrySkill => ({
	id: "@s/skill",
	scope: "user",
	cwd: null,
	range: "^1.0.0",
	installed: "1.0.0",
	...over,
});

const pluginCheck = (over: Partial<PluginCheckResult> = {}): PluginCheckResult => ({
	installed: "1.0.0",
	latest: "1.1.0",
	pinned: false,
	unversioned: false,
	...over,
});

const upgrade = (over: Partial<PluginUpgradeResult> = {}): PluginUpgradeResult => ({
	from: "1.0.0",
	to: "1.1.0",
	changed: true,
	activation: "live",
	...over,
});

const skillCheck = (over: Partial<SkillCheckResult> = {}): SkillCheckResult => ({
	installed: "1.0.0",
	latest: "1.2.0",
	within: "1.2.0",
	pinned: false,
	...over,
});

interface Harness {
	updater: ExtensionUpdater;
	states: ExtensionUpdateState[];
	inventory: HelperInventory;
	/** Helper calls in order: `<method> <id or name>`. */
	calls: string[];
	pluginChecks: Record<string, PluginCheckResult | Error>;
	upgrades: Record<string, PluginUpgradeResult | Error>;
	skillChecks: Record<string, SkillCheckResult | Error>;
	skillUpdates: Record<string, SkillUpdateResult | Error>;
	refresh: { error: Error | null };
	binaries: Record<string, McpBinary | null>;
	checks: string[][];
	checkOutput: { value: string | Error };
	updates: ToolUpdateRequest[];
	outcome: { value: ToolUpdateOutcome; onRun?: () => void };
	processes: { value: string; calls: number };
	applied: ExtensionApplyPlan[];
	clock: { now: number };
	pref: { enabled: boolean };
	blocked: { value: boolean };
	path: { value: string };
	/** Runs on every helper call (a test makes omp busy in the middle of a pass). */
	onCall: ((method: string) => void) | null;
	/** The next helper call of `method` answers with `promise` instead of its fake (a test holds a call open). */
	hold: { method: string; promise: Promise<unknown> } | null;
}

function harness(over: Partial<ExtensionUpdaterDeps> = {}, scheduled = true): Harness {
	const h: Harness = {
		updater: undefined as unknown as ExtensionUpdater,
		states: [],
		inventory: {
			marketplaces: [],
			plugins: [],
			registrySkills: [],
			pluginSkills: 0,
			localSkills: 0,
			mcpServers: [],
		},
		calls: [],
		pluginChecks: {},
		upgrades: {},
		skillChecks: {},
		skillUpdates: {},
		refresh: { error: null },
		binaries: {},
		checks: [],
		checkOutput: { value: "1.1.0\n" },
		updates: [],
		outcome: { value: { kind: "succeeded" } },
		processes: { value: "", calls: 0 },
		applied: [],
		clock: { now: 1_000_000 },
		pref: { enabled: true },
		blocked: { value: false },
		path: { value: "/nowhere" },
		onCall: null,
		hold: null,
	};
	const pick = <T>(table: Record<string, T | Error>, id: unknown): T => {
		const found = table[String(id)];
		if (found === undefined) throw new Error(`no fake for ${String(id)}`);
		if (found instanceof Error) throw found;
		return found;
	};
	h.updater = new ExtensionUpdater({
		scheduled,
		enabled: () => h.pref.enabled,
		platform: "darwin",
		toolsDir: "/tools",
		helper: async <T>(method: string, params: unknown): Promise<T> => {
			const p = params as Record<string, unknown>;
			h.calls.push(`${method.replace("extensions.", "")} ${String(p.name ?? p.id ?? "")}`.trim());
			h.onCall?.(method);
			if (h.hold?.method === method) {
				const { promise } = h.hold;
				h.hold = null;
				return promise as Promise<T>;
			}
			switch (method) {
				case EXTENSION_HELPER_METHODS.inventory:
					return h.inventory as T;
				case EXTENSION_HELPER_METHODS.marketplaceRefresh:
					if (h.refresh.error) throw h.refresh.error;
					return { updatedAt: "now" } as T;
				case EXTENSION_HELPER_METHODS.pluginCheck:
					return pick(h.pluginChecks, p.id) as T;
				case EXTENSION_HELPER_METHODS.pluginUpgrade:
					return pick(h.upgrades, p.id) as T;
				case EXTENSION_HELPER_METHODS.skillCheck:
					return pick(h.skillChecks, p.id) as T;
				case EXTENSION_HELPER_METHODS.skillUpdate:
					return pick(h.skillUpdates, p.id) as T;
				default:
					throw new Error(`unexpected ${method}`);
			}
		},
		cwds: () => ["/w/proj"],
		reaRoot: "/app/omp-builtin",
		reaEnabled: () => false,
		env: async () => ({ PATH: h.path.value }),
		testInstaller: "/fake/installer",
		blocked: () => h.blocked.value,
		runUpdate: async request => {
			h.updates.push(request);
			h.outcome.onRun?.();
			return h.outcome.value;
		},
		processes: async () => {
			h.processes.calls++;
			return h.processes.value;
		},
		apply: plan => h.applied.push(plan),
		onState: state => h.states.push(state),
		now: () => h.clock.now,
		detectBinary: async command => h.binaries[command] ?? null,
		runCheck: async command => {
			h.checks.push([command.spawn.file, ...command.spawn.args]);
			if (h.checkOutput.value instanceof Error) throw h.checkOutput.value;
			return h.checkOutput.value;
		},
		...over,
	});
	return h;
}

const row = (h: Harness, key: string): ExtensionRow => {
	const found = h.updater.state().rows.find(entry => entry.key === key);
	if (!found) throw new Error(`no row ${key}`);
	return found;
};

afterEach(() => {
	vi.useRealTimers();
});

describe("listing", () => {
	it("a launch that does not schedule lists everything and asks for nothing", async () => {
		const h = harness({}, false);
		h.inventory.marketplaces = [{ name: "official", source: "o/r", updatedAt: "" }];
		h.inventory.plugins = [plugin()];
		h.inventory.registrySkills = [skill()];
		h.inventory.pluginSkills = 3;
		h.inventory.mcpServers = [server("web", "npx", ["-y", "pkg"])];
		h.updater.start();
		await h.updater.rescan();
		expect(h.updater.state()).toMatchObject({ enabled: true, scheduled: false });
		expect(h.updater.state().rows.map(entry => entry.key)).toEqual([
			"marketplace:official",
			"plugin:tools@official:user",
			"skill:@s/skill:user",
			"skill:plugin",
			"mcp:web",
		]);
		expect(h.calls).toEqual(["inventory", "inventory"]);
		expect(h.checks).toEqual([]);
		expect(h.updates).toEqual([]);
		expect(h.applied).toEqual([]);
	});

	it("passes the workspaces of the open tabs to the inventory, and keeps a row's result across scans", async () => {
		const inventory: unknown[] = [];
		const h = harness({
			helper: async <T>(_method: string, params: unknown): Promise<T> => {
				inventory.push(params);
				return {
					marketplaces: [{ name: "m", source: "s", updatedAt: "" }],
					plugins: [],
					registrySkills: [],
					pluginSkills: 0,
					localSkills: 0,
					mcpServers: [],
				} as T;
			},
		});
		await h.updater.updateNow();
		expect(inventory[0]).toEqual({ cwds: ["/w/proj"] });
		expect(row(h, "marketplace:m").last).toEqual({ kind: "refreshed" });
		await h.updater.rescan();
		expect(row(h, "marketplace:m").last).toEqual({ kind: "refreshed" });
		h.updater.dispose();
	});

	it("keeps the rows it has when the inventory cannot be read", async () => {
		let fail = false;
		const h = harness({
			helper: async <T>(): Promise<T> => {
				if (fail) throw new Error("omp is not installed");
				return {
					marketplaces: [{ name: "m", source: "s", updatedAt: "" }],
					plugins: [],
					registrySkills: [],
					pluginSkills: 0,
					localSkills: 0,
					mcpServers: [],
				} as T;
			},
		});
		await h.updater.rescan();
		fail = true;
		await h.updater.rescan();
		await h.updater.updateNow();
		expect(h.updater.state().rows).toHaveLength(1);
	});

	it("lists the built-in REA when the app has it on, and never checks it", async () => {
		const h = harness({ reaEnabled: () => true });
		await h.updater.updateNow();
		expect(row(h, "mcp:rea")).toMatchObject({ skip: "builtin", method: null, last: null });
		expect(h.checks).toEqual([]);
	});
});

describe("a pass", () => {
	it("goes marketplaces → plugins → skills → MCP servers and applies once at the end", async () => {
		const h = harness();
		h.inventory = {
			marketplaces: [{ name: "official", source: "o/r", updatedAt: "" }],
			plugins: [plugin(), plugin({ channel: "npm", id: "live-plug", installed: "2.0.0", spec: "^2.0.0" })],
			registrySkills: [skill()],
			pluginSkills: 0,
			localSkills: 0,
			mcpServers: [server("pkg", "pkg")],
		};
		h.binaries.pkg = binary();
		h.pluginChecks["tools@official"] = pluginCheck();
		h.pluginChecks["live-plug"] = pluginCheck({ installed: "2.0.0", latest: "2.1.0" });
		h.upgrades["tools@official"] = upgrade({ activation: "restart-required" });
		h.upgrades["live-plug"] = upgrade({ from: "2.0.0", to: "2.1.0" });
		h.skillChecks["@s/skill"] = skillCheck();
		h.skillUpdates["@s/skill"] = { blocked: null, from: "1.0.0", to: "1.2.0", changed: true };
		h.outcome.onRun = () => {
			h.binaries.pkg = binary({ installed: "1.1.0" });
		};
		await h.updater.updateNow();
		expect(h.calls).toEqual([
			"inventory",
			"marketplace.refresh official",
			"plugin.check live-plug",
			"plugin.upgrade live-plug",
			"plugin.check tools@official",
			"plugin.upgrade tools@official",
			"skill.check @s/skill",
			"skill.update @s/skill",
		]);
		expect(row(h, "marketplace:official").last).toEqual({ kind: "refreshed" });
		expect(row(h, "plugin:tools@official:user")).toMatchObject({
			installed: "1.1.0",
			latest: "1.1.0",
			last: { kind: "updated", from: "1.0.0", to: "1.1.0" },
		});
		expect(row(h, "skill:@s/skill:user")).toMatchObject({
			installed: "1.2.0",
			last: { kind: "updated", to: "1.2.0" },
		});
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "updated", from: "1.0.0", to: "1.1.0" });
		// One plan for the whole pass: a restart (one plugin binds at session creation), the reload, the reconnect.
		expect(h.applied).toEqual([{ reload: true, restart: true, reconnect: ["pkg"] }]);
	});

	it("a refreshed marketplace alone changes nothing in a live tab", async () => {
		const h = harness();
		h.inventory.marketplaces = [{ name: "m", source: "s", updatedAt: "" }];
		await h.updater.updateNow();
		expect(row(h, "marketplace:m")).toMatchObject({ last: { kind: "refreshed" }, phase: "idle", method: "catalog" });
		expect(row(h, "marketplace:m").checkedAt).toBe(h.clock.now);
		expect(h.applied).toEqual([]);
	});

	it("a plugin that is current, or only changes nothing, applies nothing", async () => {
		const h = harness();
		h.inventory.plugins = [plugin(), plugin({ id: "same@official" })];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.pluginChecks["same@official"] = pluginCheck({ latest: "1.1.0" });
		h.upgrades["same@official"] = upgrade({ changed: false });
		await h.updater.updateNow();
		expect(row(h, "plugin:tools@official:user").last).toEqual({ kind: "current" });
		expect(row(h, "plugin:same@official:user").last).toEqual({ kind: "current" });
		expect(h.calls).not.toContain("plugin.upgrade tools@official");
		expect(h.applied).toEqual([]);
	});

	it("never upgrades an npm plugin to a version that is not strictly newer (a prerelease user stays)", async () => {
		const h = harness();
		h.inventory.plugins = [
			plugin({ channel: "npm", id: "beta-plug", installed: "2.0.0-beta.1", spec: "^2.0.0-beta.1" }),
		];
		h.pluginChecks["beta-plug"] = pluginCheck({ installed: "2.0.0-beta.1", latest: "1.9.0" });
		await h.updater.updateNow();
		expect(h.calls).not.toContain("plugin.upgrade beta-plug");
		expect(row(h, "plugin:beta-plug:user").last).toEqual({ kind: "current" });
		// …but the release after the prerelease is newer.
		h.pluginChecks["beta-plug"] = pluginCheck({ installed: "2.0.0-beta.1", latest: "2.0.0" });
		h.upgrades["beta-plug"] = upgrade({ from: "2.0.0-beta.1", to: "2.0.0" });
		await h.updater.updateNow();
		expect(row(h, "plugin:beta-plug:user").last).toMatchObject({ kind: "updated", to: "2.0.0" });
	});

	it("a git plugin has no latest to read: the upgrade decides", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ channel: "git", id: "git-plug", installed: null, spec: "github:o/r" })];
		h.pluginChecks["git-plug"] = pluginCheck({ installed: null, latest: null });
		h.upgrades["git-plug"] = upgrade({ changed: false, from: null, to: null });
		await h.updater.updateNow();
		expect(h.calls).toContain("plugin.upgrade git-plug");
		expect(row(h, "plugin:git-plug:user").last).toEqual({ kind: "current" });
		h.upgrades["git-plug"] = upgrade({ from: null, to: "abc1234" });
		await h.updater.updateNow();
		expect(row(h, "plugin:git-plug:user")).toMatchObject({
			installed: "abc1234",
			last: { kind: "updated", from: null, to: "abc1234" },
		});
		expect(h.applied).toEqual([{ reload: true, restart: false, reconnect: [] }]);
	});

	it("a plugin's failed check or upgrade is a recorded failure, never a throw", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ id: "a@official" }), plugin({ id: "b@official" })];
		h.pluginChecks["a@official"] = new Error("catalog unreachable");
		h.pluginChecks["b@official"] = pluginCheck();
		h.upgrades["b@official"] = new Error("bun install failed");
		await h.updater.updateNow();
		expect(row(h, "plugin:a@official:user").last).toEqual({
			kind: "failed",
			failure: { reason: "check", detail: "catalog unreachable" },
		});
		expect(row(h, "plugin:b@official:user").last).toEqual({
			kind: "failed",
			failure: { reason: "install", detail: "bun install failed" },
		});
		expect(row(h, "plugin:b@official:user").phase).toBe("idle");
		expect(h.applied).toEqual([]);
	});

	it("a linked plugin is listed and never asked about", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ channel: "linked", id: "dev" })];
		await h.updater.updateNow();
		expect(row(h, "plugin:dev:user")).toMatchObject({ skip: "linked", method: null, last: null });
		expect(h.calls).toEqual(["inventory"]);
	});
});

describe("a pass that never ends", () => {
	it("is stopped, leaves its row idle, and when it resumes later applies and writes nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = Promise.withResolvers<PluginUpgradeResult>();
		const h = harness({}, false);
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck();
		h.upgrades["tools@official"] = upgrade();
		h.hold = { method: EXTENSION_HELPER_METHODS.pluginUpgrade, promise: answer.promise };
		const stale = h.updater.updateNow().then(
			() => null,
			error => error,
		);
		await vi.waitFor(() => expect(row(h, "plugin:tools@official:user").phase).toBe("updating"));
		const next = h.updater.updateNow();
		await vi.advanceTimersByTimeAsync(UPDATE_STEP_MAX_MS);
		expect(((await stale) as Error).name).toBe("StepStalledError");
		await next;
		expect(row(h, "plugin:tools@official:user").phase).toBe("idle");
		const applied = h.applied.length;
		const emitted = h.states.length;
		const before = JSON.stringify(h.updater.state());
		// The stopped pass's upgrade answers after the next pass ran: nothing is applied, no state changes.
		answer.resolve(upgrade({ activation: "restart-required" }));
		await vi.advanceTimersByTimeAsync(1000);
		await new Promise<void>(done => setImmediate(done));
		expect(h.applied).toHaveLength(applied);
		expect(h.states).toHaveLength(emitted);
		expect(JSON.stringify(h.updater.state())).toBe(before);
	});
});

describe("pins", () => {
	it("a pinned plugin is checked and shown as available, and is never upgraded, not even by Update now", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ channel: "npm", id: "pin-plug", installed: "1.0.0", spec: "1.0.0" })];
		h.pluginChecks["pin-plug"] = pluginCheck({ latest: "1.5.0", pinned: true });
		h.upgrades["pin-plug"] = upgrade();
		h.updater.start();
		await h.updater.rescan();
		await h.updater.updateNow("plugin:pin-plug:user");
		await h.updater.updateNow();
		expect(h.calls.filter(call => call.startsWith("plugin.upgrade"))).toEqual([]);
		expect(row(h, "plugin:pin-plug:user")).toMatchObject({
			skip: "pinned",
			latest: "1.5.0",
			last: { kind: "available", latest: "1.5.0" },
		});
		// The pin survives a rescan between checks.
		await h.updater.rescan();
		expect(row(h, "plugin:pin-plug:user").skip).toBe("pinned");
		// A pinned plugin that is not behind is just current.
		h.pluginChecks["pin-plug"] = pluginCheck({ latest: "1.0.0", pinned: true });
		await h.updater.updateNow();
		expect(row(h, "plugin:pin-plug:user").last).toEqual({ kind: "current" });
		// Unpinned by the user: it follows again.
		h.pluginChecks["pin-plug"] = pluginCheck({ latest: "1.5.0" });
		h.upgrades["pin-plug"] = upgrade({ to: "1.5.0" });
		await h.updater.updateNow();
		expect(row(h, "plugin:pin-plug:user")).toMatchObject({ skip: null, last: { kind: "updated", to: "1.5.0" } });
		h.updater.dispose();
	});

	it("an unversioned marketplace plugin is not upgraded", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ installed: "0.0.0" })];
		h.pluginChecks["tools@official"] = pluginCheck({ installed: "0.0.0", latest: null, unversioned: true });
		await h.updater.updateNow();
		expect(row(h, "plugin:tools@official:user")).toMatchObject({ skip: "unversioned" });
		expect(h.calls).not.toContain("plugin.upgrade tools@official");
	});

	it("a skill pinned by an exact range is checked, shown, and never updated", async () => {
		const h = harness();
		h.inventory.registrySkills = [skill({ range: "1.0.0" })];
		h.skillChecks["@s/skill"] = skillCheck({ pinned: true });
		await h.updater.updateNow("skill:@s/skill:user");
		expect(row(h, "skill:@s/skill:user")).toMatchObject({
			skip: "pinned",
			last: { kind: "available", latest: "1.2.0" },
		});
		expect(h.calls.filter(call => call.startsWith("skill.update"))).toEqual([]);
	});

	it("a pinned MCP runner package is checked against the registry and never changed", async () => {
		const h = harness();
		h.inventory.mcpServers = [server("s", "npx", ["-y", "@scope/pkg@1.2.3"])];
		h.checkOutput.value = "1.4.0\n";
		await h.updater.updateNow("mcp:s");
		expect(h.checks).toEqual([["/fake/installer", "cli-mcp-s", "npm", "check"]]);
		expect(row(h, "mcp:s")).toMatchObject({
			skip: "pinned",
			method: "npm",
			installed: "1.2.3",
			detail: "@scope/pkg@1.2.3",
			latest: "1.4.0",
			last: { kind: "available", latest: "1.4.0" },
		});
		expect(h.updates).toEqual([]);
		expect(h.applied).toEqual([]);
		h.checkOutput.value = "1.2.3\n";
		await h.updater.updateNow("mcp:s");
		expect(row(h, "mcp:s").last).toEqual({ kind: "current" });
		// A tag or range has no installed version to be behind.
		h.inventory.mcpServers = [server("t", "npx", ["pkg@next"])];
		h.checkOutput.value = "9.0.0\n";
		await h.updater.updateNow("mcp:t");
		expect(row(h, "mcp:t")).toMatchObject({ latest: "9.0.0", last: { kind: "current" } });
		expect(h.updates).toEqual([]);
	});

	it("checks a pinned runner package through the real registry command when no installer is set", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-ext-updater-")));
		try {
			await fs.mkdir(path.join(dir, "bin"));
			await fs.writeFile(path.join(dir, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
			await fs.writeFile(path.join(dir, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
			const h = harness({ testInstaller: null });
			h.path.value = path.join(dir, "bin");
			h.inventory.mcpServers = [server("n", "npx", ["pkg@1.0.0"]), server("p", "uvx", ["mcp-thing==1.0.0"])];
			h.checkOutput.value = "1.0.1\n";
			await h.updater.updateNow("mcp:n");
			h.checkOutput.value = "mcp-thing (1.0.2)\nAvailable versions: 1.0.2, 1.0.0\n";
			await h.updater.updateNow("mcp:p");
			expect(h.checks).toEqual([
				[path.join(dir, "bin", "npm"), "view", "pkg", "version"],
				[path.join(dir, "bin", "python3"), "-m", "pip", "index", "versions", "mcp-thing"],
			]);
			expect(row(h, "mcp:n").last).toEqual({ kind: "available", latest: "1.0.1" });
			expect(row(h, "mcp:p")).toMatchObject({ method: "uv", last: { kind: "available", latest: "1.0.2" } });
			// No python and no npm: nothing to ask, the row stays pinned.
			h.path.value = "/nowhere";
			await h.updater.updateNow("mcp:n");
			expect(row(h, "mcp:n")).toMatchObject({ skip: "pinned", last: { kind: "current" } });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("an unpinned runner package follows latest: no check at all", async () => {
		const h = harness();
		h.inventory.mcpServers = [server("s", "npx", ["-y", "pkg"])];
		await h.updater.updateNow();
		expect(row(h, "mcp:s")).toMatchObject({ skip: "follows-latest", method: null, last: null });
		expect(h.checks).toEqual([]);
		expect(h.updates).toEqual([]);
	});
});

describe("skills", () => {
	it("updates to what the range resolves to when that is newer, and reloads", async () => {
		const h = harness();
		h.inventory.registrySkills = [skill()];
		h.skillChecks["@s/skill"] = skillCheck({ latest: "2.0.0", within: "1.2.0" });
		h.skillUpdates["@s/skill"] = { blocked: null, from: "1.0.0", to: "1.2.0", changed: true };
		await h.updater.updateNow();
		expect(row(h, "skill:@s/skill:user")).toMatchObject({
			latest: "2.0.0",
			installed: "1.2.0",
			last: { kind: "updated", from: "1.0.0", to: "1.2.0" },
		});
		expect(h.applied).toEqual([{ reload: true, restart: false, reconnect: [] }]);
	});

	it("a newer version outside the range is not installed", async () => {
		const h = harness();
		h.inventory.registrySkills = [skill()];
		h.skillChecks["@s/skill"] = skillCheck({ latest: "2.0.0", within: "1.0.0" });
		await h.updater.updateNow();
		expect(h.calls).not.toContain("skill.update @s/skill");
		expect(row(h, "skill:@s/skill:user").last).toEqual({ kind: "current" });
	});

	it("a new version that ships scripts needs the user: a failure, never an approval", async () => {
		const h = harness();
		h.inventory.registrySkills = [skill()];
		h.skillChecks["@s/skill"] = skillCheck();
		h.skillUpdates["@s/skill"] = { blocked: "needs-approval", version: "1.2.0" };
		await h.updater.updateNow();
		expect(row(h, "skill:@s/skill:user").last).toEqual({
			kind: "failed",
			failure: { reason: "needs-approval", detail: "1.2.0" },
		});
		expect(h.applied).toEqual([]);
	});

	it("plugin skills and local skills are rows with a count and a reason, never asked about", async () => {
		const h = harness();
		h.inventory.pluginSkills = 3;
		h.inventory.localSkills = 5;
		await h.updater.updateNow();
		expect(row(h, "skill:plugin")).toMatchObject({ count: 3, skip: "follows-plugin", method: null });
		expect(row(h, "skill:local")).toMatchObject({ count: 5, skip: "local", method: null });
		expect(h.calls).toEqual(["inventory"]);
	});
});

describe("MCP binaries", () => {
	function withServer(h: Harness, found: McpBinary | null = binary()) {
		h.inventory.mcpServers = [server("pkg", "pkg")];
		h.binaries.pkg = found;
	}

	it("checks through the installer, updates under the setup supervisor, reads the version again, reconnects", async () => {
		const h = harness();
		withServer(h);
		h.outcome.onRun = () => {
			h.binaries.pkg = binary({ installed: "1.1.0" });
		};
		await h.updater.updateNow("mcp:pkg");
		expect(h.checks).toEqual([["/fake/installer", "cli-mcp-pkg", "npm", "check"]]);
		expect(h.updates).toEqual([{ tool: "mcp-pkg", method: "npm", spawn: null, env: {} }]);
		expect(row(h, "mcp:pkg")).toMatchObject({
			method: "npm",
			detail: "@s/pkg",
			installed: "1.1.0",
			latest: "1.1.0",
			last: { kind: "updated", from: "1.0.0", to: "1.1.0" },
		});
		expect(h.applied).toEqual([{ reload: false, restart: false, reconnect: ["pkg"] }]);
	});

	it("without an installer it asks the owner and runs the owner's own update", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-ext-updater-")));
		try {
			await fs.mkdir(path.join(dir, "bin"));
			await fs.writeFile(path.join(dir, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
			const h = harness({ testInstaller: null });
			h.path.value = path.join(dir, "bin");
			withServer(h);
			h.outcome.onRun = () => {
				h.binaries.pkg = binary({ installed: "1.1.0" });
			};
			await h.updater.updateNow("mcp:pkg");
			expect(h.checks).toEqual([[path.join(dir, "bin", "npm"), "view", "@s/pkg", "version"]]);
			expect(h.updates[0]).toMatchObject({
				tool: "mcp-pkg",
				method: "npm",
				spawn: { file: path.join(dir, "bin", "npm"), args: ["install", "-g", "--prefix", "/p", "@s/pkg@1.1.0"] },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("leaves a current server alone, and compares versions as numbers", async () => {
		const h = harness();
		withServer(h, binary({ installed: "1.10.0" }));
		h.checkOutput.value = "1.9.0\n";
		await h.updater.updateNow("mcp:pkg");
		expect(h.updates).toEqual([]);
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "current" });
	});

	it("an update that leaves the old version, a failure and a cancel are recorded", async () => {
		const h = harness();
		withServer(h);
		await h.updater.updateNow("mcp:pkg");
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "failed", failure: { reason: "not-updated" } });
		expect(h.applied).toEqual([]);
		h.outcome.value = { kind: "failed", detail: "EACCES" };
		await h.updater.updateNow("mcp:pkg");
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "failed", failure: { reason: "install", detail: "EACCES" } });
		h.outcome.value = { kind: "cancelled" };
		await h.updater.updateNow("mcp:pkg");
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "failed", failure: { reason: "cancelled" } });
		h.checkOutput.value = new Error("registry down");
		await h.updater.updateNow("mcp:pkg");
		expect(row(h, "mcp:pkg").last).toEqual({ kind: "failed", failure: { reason: "check", detail: "registry down" } });
	});

	it("a disabled server is listed, not checked", async () => {
		const h = harness();
		h.inventory.mcpServers = [server("pkg", "pkg", [], { enabled: false })];
		h.binaries.pkg = binary();
		await h.updater.updateNow();
		expect(row(h, "mcp:pkg")).toMatchObject({ method: "npm", last: null });
		expect(h.checks).toEqual([]);
	});

	it("system, bundled, not-writable and unknown binaries are listed with their reason and never touched", async () => {
		for (const skip of ["system", "bundled", "not-writable", "unknown-install"] as const) {
			const h = harness();
			withServer(h, binary({}, null));
			h.binaries.pkg = { ...binary({}, null), skip };
			await h.updater.updateNow();
			expect(row(h, "mcp:pkg"), skip).toMatchObject({ skip, method: null, last: null });
			expect(h.checks).toEqual([]);
			expect(h.updates).toEqual([]);
		}
	});

	describe("the running rule", () => {
		const running = "node /p/lib/node_modules/@s/pkg/bin/cli.js --stdio\n";

		it("a script waits while its server runs, then updates at the next check; a deferral is no failure", async () => {
			const h = harness();
			withServer(h);
			h.processes.value = running;
			await h.updater.updateNow("mcp:pkg");
			expect(h.updates).toEqual([]);
			expect(row(h, "mcp:pkg")).toMatchObject({
				last: { kind: "deferred", latest: "1.1.0", why: "running" },
				installed: "1.0.0",
			});
			expect(h.applied).toEqual([]);
			// Scheduled passes are not held back by it.
			h.updater.start();
			await h.updater.rescan();
			expect(h.updates).toEqual([]);
			expect(h.processes.calls).toBeGreaterThan(1);
			h.processes.value = "/sbin/launchd\n";
			h.outcome.onRun = () => {
				h.binaries.pkg = binary({ installed: "1.1.0" });
			};
			h.updater.prefChanged();
			await h.updater.rescan();
			expect(row(h, "mcp:pkg").last).toMatchObject({ kind: "updated", to: "1.1.0" });
			h.updater.dispose();
		});

		it("a native binary keeps its old inode: it updates at once, running or not", async () => {
			const h = harness();
			withServer(h, binary({ script: false }, { method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" }));
			h.processes.value = "/p/lib/node_modules/@s/pkg/bin/cli.js\n";
			h.outcome.onRun = () => {
				h.binaries.pkg = binary(
					{ script: false, installed: "1.1.0" },
					{ method: "brew", name: "thing", brew: "/opt/homebrew/bin/brew" },
				);
			};
			await h.updater.updateNow("mcp:pkg");
			expect(h.processes.calls).toBe(0);
			expect(h.updates).toHaveLength(1);
			expect(row(h, "mcp:pkg").last).toMatchObject({ kind: "updated" });
		});

		it("a script owned by pipx, uv or pip waits too; a missing process updates", async () => {
			for (const owner of [
				{ method: "pipx", name: "t", venv: "/h/pipx/venvs/t" },
				{ method: "uv", name: "t", dir: "/h/uv/tools/t" },
				{ method: "pip", name: "t", python: "/py/python3" },
			] as const) {
				const h = harness();
				withServer(h, binary({ real: "/h/tools/t/bin/t", path: "/h/bin/pkg" }, owner));
				h.processes.value = "/usr/bin/python3 /h/tools/t/bin/t\n";
				await h.updater.updateNow("mcp:pkg");
				expect(h.updates, owner.method).toEqual([]);
				expect(row(h, "mcp:pkg").last, owner.method).toMatchObject({ kind: "deferred", why: "running" });
				h.processes.value = "";
				await h.updater.updateNow("mcp:pkg");
				expect(h.updates, owner.method).toHaveLength(1);
			}
		});

		it("on Windows nothing is scanned: a held file just fails the update, recorded and retried", async () => {
			const h = harness({ platform: "win32" });
			withServer(h);
			h.processes.value = running;
			h.outcome.value = { kind: "failed", detail: "EBUSY: resource busy or locked" };
			await h.updater.updateNow("mcp:pkg");
			expect(h.processes.calls).toBe(0);
			expect(row(h, "mcp:pkg").last).toEqual({
				kind: "failed",
				failure: { reason: "install", detail: "EBUSY: resource busy or locked" },
			});
		});
	});

	it("uv has no read-only check: the owner's own upgrade is the check, compared before and after", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-ext-updater-")));
		try {
			await fs.mkdir(path.join(dir, "bin"));
			await fs.writeFile(path.join(dir, "bin", "uv"), "#!/bin/sh\n", { mode: 0o755 });
			const h = harness({ testInstaller: null });
			h.path.value = path.join(dir, "bin");
			const uv: McpOwner = { method: "uv", name: "mcp-thing", dir: "/h/uv/tools/mcp-thing" };
			withServer(h, binary({ script: false }, uv));
			await h.updater.updateNow("mcp:pkg");
			expect(h.checks).toEqual([]);
			expect(h.updates[0]?.spawn).toMatchObject({
				file: path.join(dir, "bin", "uv"),
				args: ["tool", "upgrade", "mcp-thing"],
			});
			// Nothing moved and nothing was newer: it was current.
			expect(row(h, "mcp:pkg")).toMatchObject({ latest: null, last: { kind: "current" } });
			h.outcome.onRun = () => {
				h.binaries.pkg = binary({ script: false, installed: "1.3.0" }, uv);
			};
			await h.updater.updateNow("mcp:pkg");
			expect(row(h, "mcp:pkg").last).toEqual({ kind: "updated", from: "1.0.0", to: "1.3.0" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("an owner with no tool to run the update with is a recorded failure", async () => {
		const h = harness({ testInstaller: null });
		withServer(h);
		h.path.value = "/nowhere";
		await h.updater.updateNow("mcp:pkg");
		// No npm on PATH: no check either, so the latest is unknown; the update has no command.
		expect(row(h, "mcp:pkg").last).toEqual({
			kind: "failed",
			failure: { reason: "install", detail: "no npm to run the update with" },
		});
		expect(h.updates).toEqual([]);
	});
});

describe("schedule", () => {
	it("runs on the 4 h cadence from launch", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.inventory.marketplaces = [{ name: "m", source: "s", updatedAt: "" }];
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls.filter(call => call.startsWith("marketplace.refresh"))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(h.calls.filter(call => call.startsWith("marketplace.refresh"))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.calls.filter(call => call.startsWith("marketplace.refresh"))).toHaveLength(2);
		h.updater.dispose();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.calls.filter(call => call.startsWith("marketplace.refresh"))).toHaveLength(2);
	});

	it("each row backs off by itself after failures; Update now and other rows are not held", async () => {
		const h = harness();
		h.inventory.plugins = [plugin({ id: "bad@official" }), plugin({ id: "good@official" })];
		h.pluginChecks["bad@official"] = new Error("catalog unreachable");
		h.pluginChecks["good@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.start();
		await h.updater.rescan();
		const count = (id: string) => h.calls.filter(call => call === `plugin.check ${id}`).length;
		expect([count("bad@official"), count("good@official")]).toEqual([1, 1]);
		// One failure: 4 h × 2 before the next scheduled try; the healthy row is checked every time.
		h.clock.now += CHECK_INTERVAL_MS;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect([count("bad@official"), count("good@official")]).toEqual([1, 2]);
		h.clock.now += nextCheckDelay(1);
		h.updater.prefChanged();
		await h.updater.rescan();
		expect([count("bad@official"), count("good@official")]).toEqual([2, 3]);
		// Update now ignores the back-off.
		await h.updater.updateNow("plugin:bad@official:user");
		expect(count("bad@official")).toBe(3);
		// A good run clears it.
		h.pluginChecks["bad@official"] = pluginCheck({ latest: "1.0.0" });
		await h.updater.updateNow("plugin:bad@official:user");
		h.clock.now += CHECK_INTERVAL_MS;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(count("bad@official")).toBe(5);
		h.updater.dispose();
	});

	it("a cancelled update does not back off", async () => {
		const h = harness();
		h.inventory.mcpServers = [server("pkg", "pkg")];
		h.binaries.pkg = binary();
		h.outcome.value = { kind: "cancelled" };
		h.updater.start();
		await h.updater.rescan();
		h.updates.length = 0;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.updates).toHaveLength(1);
		h.updater.dispose();
	});

	it("while omp is being installed a pass asks nothing, defers without a back-off, and the next pass goes ahead", async () => {
		const h = harness();
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.start();
		await h.updater.rescan();
		h.calls.length = 0;
		h.blocked.value = true;
		await h.updater.updateNow();
		expect(h.calls).toEqual([]);
		expect(row(h, "plugin:tools@official:user").last).toEqual({ kind: "deferred", latest: "1.0.0", why: "omp-busy" });
		h.updater.prefChanged();
		await h.updater.rescan();
		await h.updater.rescan();
		expect(h.calls).toEqual([]);
		h.blocked.value = false;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.calls).toContain("plugin.check tools@official");
		expect(row(h, "plugin:tools@official:user").last).toEqual({ kind: "current" });
		h.updater.dispose();
	});

	it("omp becoming busy mid-pass defers the rows still to do", async () => {
		const h = harness();
		h.inventory.marketplaces = [{ name: "m", source: "s", updatedAt: "" }];
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck();
		h.onCall = method => {
			if (method === EXTENSION_HELPER_METHODS.marketplaceRefresh) h.blocked.value = true;
		};
		await h.updater.updateNow();
		expect(row(h, "marketplace:m").last).toEqual({ kind: "refreshed" });
		expect(row(h, "plugin:tools@official:user").last).toEqual({ kind: "deferred", latest: null, why: "omp-busy" });
		expect(h.calls).not.toContain("plugin.check tools@official");
	});

	it("with the pref off a scheduled launch only lists; Update now ignores the pref; turning it on checks at once", async () => {
		const h = harness();
		h.pref.enabled = false;
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.start();
		await h.updater.rescan();
		expect(h.updater.state()).toMatchObject({ enabled: false, scheduled: true });
		expect(h.updater.state().rows).toHaveLength(1);
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.calls.filter(call => call.startsWith("plugin.check"))).toEqual([]);
		await h.updater.updateNow("plugin:tools@official:user");
		expect(h.calls.filter(call => call.startsWith("plugin.check"))).toHaveLength(1);
		h.pref.enabled = true;
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.calls.filter(call => call.startsWith("plugin.check"))).toHaveLength(2);
		h.updater.dispose();
	});

	it("a launch that does not schedule checks only on request, even with the pref on", async () => {
		const h = harness({}, false);
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.start();
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(h.calls.filter(call => call.startsWith("plugin.check"))).toEqual([]);
		await h.updater.updateNow();
		expect(h.calls.filter(call => call.startsWith("plugin.check"))).toHaveLength(1);
	});

	it("a throw from a dependency does not end the schedule, and dispose stops it", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const h = harness({
			env: async () => {
				calls++;
				throw new Error("no shell env");
			},
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(calls).toBe(2);
		h.updater.dispose();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(calls).toBe(2);
		await h.updater.updateNow();
		expect(calls).toBe(2);
	});

	it("tells the UI each phase, ending idle", async () => {
		const h = harness();
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck();
		h.upgrades["tools@official"] = upgrade();
		await h.updater.updateNow();
		const phases = h.states.map(state => state.rows.find(entry => entry.key === "plugin:tools@official:user")?.phase);
		expect(phases).toContain("checking");
		expect(phases).toContain("updating");
		expect(phases.at(-1)).toBe("idle");
	});

	it("keeps the 4 h timer after a row fails; that row waits out its own back-off (8 h)", async () => {
		vi.useFakeTimers();
		const h = harness({ now: () => Date.now() });
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = new Error("catalog unreachable");
		const checks = () => h.calls.filter(call => call === "plugin.check tools@official").length;
		const scans = () => h.calls.filter(call => call === "inventory").length;
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect([scans(), checks()]).toEqual([1, 1]);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect([scans(), checks()]).toEqual([2, 1]);
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect([scans(), checks()]).toEqual([3, 2]);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect([scans(), checks()]).toEqual([4, 3]);
		h.updater.dispose();
	});

	it("runs one pass at a time: a request during a pass waits for it, and a failed one does not stop the queue", async () => {
		const gate = Promise.withResolvers<void>();
		const order: string[] = [];
		let passes = 0;
		const h = harness({
			env: async () => {
				passes++;
				order.push(`pass ${passes}`);
				if (passes === 1) await gate.promise;
				return { PATH: "/nowhere" };
			},
		});
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.onCall = method => order.push(method.replace("extensions.", ""));
		const one = h.updater.updateNow();
		const two = h.updater.updateNow();
		gate.resolve();
		await Promise.all([one, two]);
		expect(order).toEqual(["pass 1", "inventory", "plugin.check", "pass 2", "inventory", "plugin.check"]);

		let throws = true;
		const failing = harness({
			blocked: () => {
				if (throws) throw new Error("setup state unreadable");
				return false;
			},
		});
		failing.inventory.plugins = [plugin()];
		failing.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		await expect(failing.updater.updateNow()).rejects.toThrow("setup state unreadable");
		throws = false;
		await failing.updater.updateNow();
		expect(failing.calls).toContain("plugin.check tools@official");
	});

	it("a rejected scheduled pass keeps the timer going", async () => {
		vi.useFakeTimers();
		let throws = true;
		const h = harness({
			blocked: () => {
				if (throws) throw new Error("setup state unreadable");
				return false;
			},
		});
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual([]);
		throws = false;
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toContain("plugin.check tools@official");
		h.updater.dispose();
	});

	it("drops work queued before dispose, and a pref change before start does nothing", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let passes = 0;
		const h = harness({
			env: async () => {
				passes++;
				// The first call is the rescan below; the next is the pass dispose lands in.
				if (passes === 1) return { PATH: "/nowhere" };
				started.resolve();
				await gate.promise;
				return { PATH: "/nowhere" };
			},
		});
		h.inventory.plugins = [plugin()];
		h.pluginChecks["tools@official"] = pluginCheck({ latest: "1.0.0" });
		h.updater.prefChanged();
		await h.updater.rescan();
		expect(passes).toBe(1);
		expect(h.calls).toEqual(["inventory"]);
		const one = h.updater.updateNow();
		const two = h.updater.updateNow();
		await started.promise;
		h.updater.dispose();
		gate.resolve();
		await Promise.all([one, two]);
		expect(passes).toBe(2);
		h.updater.start();
		await h.updater.updateNow();
		expect(passes).toBe(2);
	});
});

describe("registerExtensionUpdateIpc", () => {
	function register(rows: string[] = ["plugin:a@m:user"]) {
		const ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
		const caller: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };
		const state = {
			enabled: true,
			scheduled: true,
			rows: rows.map(key => ({ key }) as ExtensionRow),
		} as ExtensionUpdateState;
		const updater = {
			state: vi.fn(() => state),
			updateNow: vi.fn(async (_key?: string) => {}),
			rescan: vi.fn(async () => {}),
		};
		registerExtensionUpdateIpc(ipc, updater);
		const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, caller, args);
		return { call, updater, state };
	}

	it("serves the snapshot and looks for what was installed since, taking no argument", async () => {
		const { call, updater, state } = register();
		expect(await call(IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE)).toBe(state);
		expect(updater.rescan).toHaveBeenCalledTimes(1);
	});

	it("takes a row key of the current state or nothing for 'Update now', and refuses anything else", async () => {
		const { call, updater } = register();
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, "plugin:a@m:user");
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW);
		await call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, null);
		expect(updater.updateNow.mock.calls).toEqual([["plugin:a@m:user"], [], []]);
		for (const bad of [
			"rm -rf /",
			"/usr/bin/tool",
			"plugin:b@m:user",
			"plugin:a@m:user --force",
			5,
			{ key: "plugin:a@m:user" },
			"",
		]) {
			await expect(call(IPC_COMMANDS.EXTENSION_UPDATE_NOW, bad)).rejects.toThrow(/Unknown extension/);
		}
		expect(updater.updateNow).toHaveBeenCalledTimes(3);
	});
});
