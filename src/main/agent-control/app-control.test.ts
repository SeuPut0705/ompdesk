import { describe, expect, it } from "vitest";
import type { AgentAppEvent, PrivacyPane, SidebarView } from "../../shared/agent-control";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { WEB_BLOCKS_LIST } from "../../shared/mobile-web";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import {
	SIDEBAR_PROJECTS_COMMAND,
	type SidebarProjectsRequest,
	type SidebarProjectsState,
} from "../../shared/sidebar-projects";
import { SidebarProjects } from "../sidebar-projects";
import { ACTION_BY_ID, type AppAction } from "./app-catalog";
import { AppControl, type AppPorts, AppRefusal } from "./app-control";
import { prefTier, rpcTier, settingTier } from "./app-guard";
import { NO_ARGS } from "./app-schema";

const CALLER = "main0001";

class FakePorts implements AppPorts {
	prefs: Record<string, unknown> = { themeName: "dark", theme: "dark" };
	manage = false;
	full = false;
	approve = true;
	cards: { title: string; message: string }[] = [];
	writes: { key: string; value: unknown }[] = [];
	rpcs: RpcCommand[] = [];
	invoked: { channel: string; args: readonly unknown[] }[] = [];
	events: AgentAppEvent[] = [];
	notes: string[] = [];
	stock: Record<string, unknown> = { "advisor.enabled": false };
	/** The paired host each caller tab runs on; a tab not listed runs on this computer. */
	devices: Record<string, string> = {};
	/** What a paired host's own machine services hold: the Settings UI reads and writes these through its device routes. */
	host = { rotation: "quota", rea: true, desktopState: "idle" };

	device = (tab: string): string | undefined => this.devices[tab];
	getPref = (key: string): unknown => this.prefs[key];
	setPref = async (_tab: string, key: string, value: unknown): Promise<void> => {
		this.prefs[key] = value;
		this.writes.push({ key, value });
	};
	/** What an RPC command answers, by type (default `{}`). */
	rpcData: Record<string, unknown> = {};
	rpc = async (_tab: string, command: RpcCommand): Promise<RpcResponse> => {
		this.rpcs.push(command);
		if (command.type === "get_settings")
			return { type: "response", success: true, data: { values: this.stock } } as RpcResponse;
		if (command.type === "set_setting") this.stock[command.path] = command.value;
		return { type: "response", success: true, data: this.rpcData[command.type] ?? {} } as RpcResponse;
	};
	invoke = async (_tab: string, channel: string, args: readonly unknown[]): Promise<unknown> => {
		this.invoked.push({ channel, args });
		if (channel === WEB_BLOCKS_LIST) return [{ id: "node:nHOST", scope: "node", name: "Studio" }];
		if (channel === IPC_COMMANDS.ACCOUNT_ROTATION_GET) return { mode: this.host.rotation, evenSupported: true };
		if (channel === IPC_COMMANDS.ACCOUNT_ROTATION_SET) {
			this.host.rotation = String(args[0]);
			return { mode: this.host.rotation, evenSupported: true };
		}
		if (channel === IPC_COMMANDS.BUILTIN_REA_GET) return { enabled: this.host.rea, available: true };
		if (channel === IPC_COMMANDS.BUILTIN_REA_SET) {
			this.host.rea = args[0] === true;
			return { enabled: this.host.rea, available: true };
		}
		if (channel === IPC_COMMANDS.HOST_DESKTOP_GET || channel === IPC_COMMANDS.HOST_DESKTOP_UPDATE)
			return { version: "9.9.9", update: { state: this.host.desktopState } };
		return [];
	};
	fire = (_tab: string, channel: string, args: readonly unknown[]): void => {
		this.invoked.push({ channel, args });
	};
	send = (_tab: string, event: AgentAppEvent): void => {
		this.events.push(event);
	};
	confirm = async (_tab: string, title: string, message: string): Promise<boolean> => {
		this.cards.push({ title, message });
		return this.approve;
	};
	manageEnabled = (): boolean => this.manage;
	fullEnabled = (): boolean => this.full;
	note = async (_tab: string, text: string): Promise<void> => {
		this.notes.push(text);
	};
	text = (key: string, params: Record<string, string>): string =>
		key === "appChanged" ? `Agent changed: ${params.what} → ${params.value}` : `${key} ${JSON.stringify(params)}`;
	localize = (en: string): string => en;
	/** What the person's sidebar holds (a window's `useSidebarPrefs`, read by main). */
	sidebar: SidebarView = { pinnedProjects: [], pinnedSessions: [], aliases: {}, projectOrder: [] };
	sidebarView = (): SidebarView => this.sidebar;
	privacyOpened: PrivacyPane[] = [];
	privacyError: string | null = null;
	openPrivacyPane = async (pane: PrivacyPane): Promise<void> => {
		if (this.privacyError) throw new Error(this.privacyError);
		this.privacyOpened.push(pane);
	};
	callerTitle = (): string => "Main";
	autopilotCalls: unknown[] = [];
	autopilot = async (_tab: string, args: unknown): Promise<string> => {
		this.autopilotCalls.push(args);
		return "autopilot reply";
	};
}

/** A real `SidebarProjects` (in memory, no disk) behind the sidebar channel, as main answers a menu's command. */
function sidebarProjectsOn(
	ports: FakePorts,
	projects: { path: string; addedAt: number; missing?: true }[],
	missingFolders: string[] = [],
) {
	const pushes: SidebarProjectsState[] = [];
	const list = new SidebarProjects({
		read: () => ({ projects, removed: [] }),
		write: () => {},
		sessions: async () => [],
		defaultWorkspace: () => "/work",
		projectOf: async path => path,
		exists: async path => !missingFolders.includes(path),
		onState: state => pushes.push(state),
		now: () => 9,
	});
	ports.invoke = async (_tab, channel, args) => {
		ports.invoked.push({ channel, args });
		return list.command(args[0] as SidebarProjectsRequest);
	};
	return { list, pushes };
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AppRefusal) return error.message;
		throw error;
	}
	throw new Error("expected a refusal");
};

describe("ompdesk_app tiers", () => {
	it("runs a read and a change without a card, journals and toasts the change", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		expect(await control.run(CALLER, "settings.get", { ids: ["theme"] })).toContain("theme: dark");
		expect(await control.run(CALLER, "settings.theme", { value: "nord" })).toContain("Theme is now nord");
		expect(ports.cards).toEqual([]);
		expect(ports.prefs).toMatchObject({ themeName: "nord", theme: "dark" });
		expect(ports.notes).toEqual(["Agent changed: Theme → nord"]);
		expect(ports.events).toContainEqual({ kind: "pref", key: "themeName", value: "nord" });
		expect(ports.events).toContainEqual({
			kind: "toast",
			message: "Agent changed: Theme → nord",
			undo: { kind: "pref", key: "themeName", value: "dark" },
		});
	});

	it("raises the card for a sensitive action without the switch, and a refusal changes nothing", async () => {
		const ports = new FakePorts();
		ports.approve = false;
		const control = new AppControl(ports);
		const message = await refusal(
			control.run(CALLER, "settings.proxy", { value: "http://user:pw@proxy.example:8080" }),
		);
		expect(message).toContain("declined");
		expect(ports.cards).toHaveLength(1);
		expect(ports.cards[0]?.message).not.toContain("pw@");
		expect(ports.writes).toEqual([]);
	});

	it("runs a sensitive action after the card, and without a card when agentControlManage is on and the action lifts", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.toolsAutoUpdate", { value: true });
		expect(ports.cards).toHaveLength(1);
		expect(ports.prefs.toolsAutoUpdate).toBe(true);

		const open = new FakePorts();
		open.manage = true;
		await new AppControl(open).run(CALLER, "settings.toolsAutoUpdate", { value: true });
		expect(open.cards).toEqual([]);
		expect(open.prefs.toolsAutoUpdate).toBe(true);

		await new AppControl(open).run(CALLER, "updates.check", {});
		expect(open.invoked).toEqual([{ channel: IPC_COMMANDS.UPDATER_CHECK, args: [] }]);
		expect(open.cards).toEqual([]);
	});

	it("reads the disk state and runs disk care with no card", async () => {
		const ports = new FakePorts();
		const state = {
			running: false,
			automatic: true,
			usage: { measuredAt: 1, total: 2_147_483_648, parts: [{ id: "worktrees", bytes: 1_073_741_824, path: "/w" }] },
			lastRun: {
				trigger: "agent",
				startedAt: 1,
				endedAt: 2,
				freedBytes: 1_048_576,
				actions: [{ kind: "artifacts", count: 2, bytes: 1_048_576 }],
				kept: 1,
				failed: 0,
			},
		};
		ports.invoke = async (_tab, channel, args) => {
			ports.invoked.push({ channel, args });
			return state;
		};
		const control = new AppControl(ports);
		expect(await control.run(CALLER, "disk.status", {})).toContain("OMPdesk uses 2.0 GB: worktrees 1.0 GB.");
		expect(await control.run(CALLER, "disk.clean", {})).toContain("freed 1.0 MB: artifacts 2 (1.0 MB)");
		expect(ports.invoked.map(call => call.channel)).toEqual([
			IPC_COMMANDS.DISK_CARE_GET_STATE,
			IPC_COMMANDS.DISK_CARE_RUN,
		]);
		expect(ports.cards).toEqual([]);
	});

	/** Each action that asks while agentControlManage is on, with arguments that pass its schema. */
	const ALWAYS_ASKS: [string, Record<string, unknown>][] = [
		["sessions.delete", { sessionPath: "/s/a.jsonl" }],
		["memory.purge", {}],
		["memory.delete_page", { workspace: "w", project: "p", path: "notes/a.md" }],
		["memory.sweep", { workspace: "w", project: "p" }],
		["updates.apply", {}],
		["app.quit", {}],
		["accounts.github_sign_in", {}],
		["accounts.provider_sign_in", { providerId: "anthropic" }],
		["mobile_web.set_enabled", { enabled: true }],
		["extensions.install_plugin", { marketplace: "m", plugin: "p" }],
		["extensions.install_mcp", { name: "x", transport: "stdio", command: "npx", args: ["-y", "x"] }],
		["extensions.mcp_sign_in", { name: "x" }],
		["extensions.mcp_use", { name: "x" }],
		["remote.connect", { nodeId: "nHOST" }],
		["remote.unblock", { block: "node:nHOST" }],
		["remote.set_allowed_users", { users: ["kim@example.com"] }],
		["settings.proxy", { value: "http://proxy.example:8080" }],
	];

	it("asks for code, credentials, network exposure, running work and erased data even while agentControlManage is on", async () => {
		const ports = new FakePorts();
		ports.manage = true;
		ports.approve = false;
		const control = new AppControl(ports);
		for (const [id, args] of ALWAYS_ASKS) {
			ports.cards = [];
			expect(await refusal(control.run(CALLER, id, args)), id).toContain("declined");
			expect(ports.cards, id).toHaveLength(1);
		}
		// A refusal ran nothing and wrote nothing.
		expect(ports.invoked).toEqual([]);
		expect(ports.rpcs).toEqual([]);
		expect(ports.writes).toEqual([]);
		ports.approve = true;
		await control.run(CALLER, "sessions.delete", { sessionPath: "/s/a.jsonl" });
		expect(ports.invoked).toEqual([{ channel: IPC_COMMANDS.SESSIONS_DELETE, args: [{ sessionPath: "/s/a.jsonl" }] }]);
	});

	it("asks to turn mobile web on, not to turn it off, while agentControlManage is on", async () => {
		const ports = new FakePorts();
		ports.manage = true;
		await new AppControl(ports).run(CALLER, "mobile_web.set_enabled", { enabled: false });
		expect(ports.cards).toEqual([]);
		await new AppControl(ports).run(CALLER, "mobile_web.set_enabled", { enabled: true });
		expect(ports.cards).toHaveLength(1);
	});

	it("pins the actions that always ask, so a new one cannot slip in or out unseen", () => {
		const asking = Object.values(ACTION_BY_ID)
			.filter(action => action.manage && "always" in action.manage && !action.fullOnly)
			.map(action => action.id)
			.sort();
		expect(asking).toEqual(ALWAYS_ASKS.map(([id]) => id).sort());
	});

	it("runs every action that always asks without a card while agents have full control", async () => {
		const ports = new FakePorts();
		ports.full = true;
		ports.approve = false;
		const control = new AppControl(ports);
		for (const [id, args] of ALWAYS_ASKS) await control.run(CALLER, id, args);
		expect(ports.cards).toEqual([]);
		expect(ports.invoked.map(entry => entry.channel)).toContain(IPC_COMMANDS.SESSIONS_DELETE);
	});

	it("lets an agent with full control change the agent-power switches, never secrets or cards", async () => {
		const ports = new FakePorts();
		ports.full = true;
		ports.stock["tools.approvalMode"] = "yolo";
		const control = new AppControl(ports);
		await control.run(CALLER, "agent_power.set", { switch: "agentControlManage", on: false });
		await control.run(CALLER, "agent_power.set", { switch: "aiMemory", on: false });
		await control.run(CALLER, "agent_power.set", { switch: "tools.approvalMode", mode: "always-ask" });
		expect(ports.prefs.agentControlManage).toBe(false);
		expect(ports.stock["tools.approvalMode"]).toBe("always-ask");
		expect(ports.invoked).toEqual([{ channel: IPC_COMMANDS.AI_MEMORY_SET_ENABLED, args: [false] }]);
		await control.run(CALLER, "app.undo", {});
		expect(ports.stock["tools.approvalMode"]).toBe("yolo");
		expect(ports.cards).toEqual([]);
		for (const id of ["cards.answer", "credentials.read"])
			expect(await refusal(control.run(CALLER, id, {})), id).toContain("never available");
		expect(await refusal(control.run(CALLER, "settings.agentControlManage", { value: true }))).toContain(
			"Unknown action",
		);
	});

	it("refuses a never action, and the agent-power switches, while full control is off whatever manage says", async () => {
		const ports = new FakePorts();
		ports.manage = true;
		const control = new AppControl(ports);
		for (const id of ["cards.answer", "credentials.read"])
			expect(await refusal(control.run(CALLER, id, {})), id).toContain("never available");
		expect(await refusal(control.run(CALLER, "agent_power.set", { switch: "agentControlFull", on: true }))).toContain(
			"never available",
		);
		expect(await refusal(control.run(CALLER, "settings.agentControlManage", { value: true }))).toContain(
			"Unknown action",
		);
		expect(ports.cards).toEqual([]);
		expect(ports.writes).toEqual([]);
	});

	it("validates arguments in main", async () => {
		const control = new AppControl(new FakePorts());
		expect(await refusal(control.run(CALLER, "settings.theme", { value: "neon" }))).toContain("must be one of");
		expect(await refusal(control.run(CALLER, "settings.fontSize", { value: 99 }))).toContain("at most");
		expect(await refusal(control.run(CALLER, "settings.theme", { value: "nord", extra: 1 }))).toContain(
			"unknown argument",
		);
		expect(await refusal(control.run(CALLER, "settings.theme", {}))).toContain("required");
	});

	it("lists actions with schemas, filtered by area and query", () => {
		const control = new AppControl(new FakePorts());
		expect(control.list({ area: "usage" })).toContain("usage.read [read]");
		expect(control.list({ area: "usage" })).toContain('"refresh"');
		expect(control.list({ query: "theme" })).toContain("settings.theme");
		expect(control.list({ area: "permissions" })).toContain("Refused:");
		expect(control.list({ query: "zzzzzz" })).toContain("No action matches");
	});
});

describe("undo", () => {
	it("puts back the previous value of the last change, once", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.theme", { value: "nord" });
		expect(await control.run(CALLER, "app.undo", {})).toContain("Restored Theme to dark");
		expect(ports.prefs).toMatchObject({ themeName: "dark", theme: "dark" });
		expect(await refusal(control.run(CALLER, "app.undo", {}))).toContain("Nothing to undo");
	});

	it("offers no undo when nothing was set before, and undoes a stock setting through set_setting", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.autoTitle", { value: false });
		const toast = ports.events.find(event => event.kind === "toast");
		expect(toast).toMatchObject({ kind: "toast" });
		expect(toast && "undo" in toast).toBe(false);

		await control.run(CALLER, "settings.advisor.enabled", { value: true });
		expect(ports.stock["advisor.enabled"]).toBe(true);
		await control.run(CALLER, "app.undo", {});
		expect(ports.stock["advisor.enabled"]).toBe(false);
	});

	it("asks the card again to undo a sensitive change", async () => {
		const ports = new FakePorts();
		ports.prefs.toolsAutoUpdate = false;
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.toolsAutoUpdate", { value: true });
		ports.approve = false;
		expect(await refusal(control.run(CALLER, "app.undo", {}))).toContain("declined");
		expect(ports.prefs.toolsAutoUpdate).toBe(true);
	});
});

describe("what agents can never reach, by any route", () => {
	const POWER = [
		"agentControl",
		"agentControlManage",
		"agentControlApprove",
		"approvalMode",
		"pstack",
		"ecc",
		"aiMemory",
		"computer",
		"sidebar",
		"githubToken",
	];

	it("refuses the power switches and secrets as preferences", () => {
		for (const key of POWER) expect(prefTier(key), key).toBe("never");
		expect(prefTier("someUnlistedKey")).toBe("never");
		expect(prefTier("themeName")).toBe("change");
	});

	it("refuses them as stock settings and every RPC route to them", () => {
		for (const path of [
			"tools.approvalMode",
			"tools.approval",
			"secrets.enabled",
			"memory.backend",
			"computer.enabled",
			"providers.x",
		])
			expect(settingTier(path), path).toBe("never");
		const set = (path: string, value: unknown = "yolo"): RpcCommand => ({ type: "set_setting", path, value });
		expect(rpcTier(set("tools.approvalMode"))).toBe("never");
		expect(rpcTier(set("agentControlManage"))).toBe("never");
		expect(rpcTier(set("advisor.enabled", true))).toBe("change");
		expect(rpcTier({ type: "get_settings", paths: ["tools.approvalMode"] })).toBe("never");
		for (const command of [
			{ type: "bash", command: "ls" },
			{ type: "prompt", message: "x" },
			{ type: "agent_control_confirm", title: "t", message: "m" },
			{ type: "set_autopilot", action: "configure" },
			{ type: "extension_ui_response", id: "1", confirmed: true },
		] as unknown as RpcCommand[])
			expect(rpcTier(command), command.type).toBe("never");
		// A command another command carries is refused even when the outer one is allowed.
		expect(rpcTier(set("advisor.enabled", { type: "set_setting", path: "tools.approvalMode", value: "yolo" }))).toBe(
			"never",
		);
	});

	it("refuses them from inside an action: preference, RPC, nested RPC and the card channel", async () => {
		const attempts: Record<string, AppAction["run"]> = {
			pref: async ctx => {
				await ctx.setPref("agentControlManage", true);
				return { text: "" };
			},
			approve: async ctx => {
				await ctx.setPref("agentControlApprove", true);
				return { text: "" };
			},
			rpc: async ctx => {
				await ctx.rpc({ type: "set_setting", path: "tools.approvalMode", value: "yolo" });
				return { text: "" };
			},
			nested: async ctx => {
				await ctx.rpc({
					type: "set_setting",
					path: "advisor.enabled",
					value: { type: "set_setting", path: "tools.approvalMode", value: "yolo" },
				});
				return { text: "" };
			},
			card: async ctx => {
				await ctx.invoke(IPC_COMMANDS.EXTENSION_UI_RESPOND, { id: "c1", confirmed: true });
				return { text: "" };
			},
			raw: async ctx => {
				await ctx.invoke(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, "tab", { type: "bash", command: "id" });
				return { text: "" };
			},
			otherChannel: async ctx => {
				await ctx.invoke(IPC_COMMANDS.SESSIONS_DELETE, { sessionPath: "x.jsonl" });
				return { text: "" };
			},
			escalate: async ctx => {
				await ctx.setPref("toolsAutoUpdate", true);
				return { text: "" };
			},
		};
		const registry: Record<string, AppAction> = {};
		for (const [id, run] of Object.entries(attempts))
			registry[id] = {
				id,
				area: "test",
				description: "A test attempt that must be refused.",
				args: NO_ARGS,
				tier: "change",
				run,
			};
		const ports = new FakePorts();
		ports.manage = true;
		const control = new AppControl(ports, registry);
		for (const id of Object.keys(attempts)) await refusal(control.run(CALLER, id, {}));
		expect(ports.writes).toEqual([]);
		expect(ports.rpcs).toEqual([]);
		expect(ports.invoked).toEqual([]);
	});
});

describe("MCP install, pairing and Autopilot", () => {
	it("shows the exact command and arguments on the card before adding an MCP server, and sends them unchanged", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		await control.run(CALLER, "extensions.install_mcp", {
			name: "files",
			transport: "stdio",
			command: "npx",
			args: ["-y", "some-mcp@1.2.3", "/tmp"],
		});
		expect(ports.cards).toHaveLength(1);
		expect(ports.cards[0]?.message).toContain("runs: npx -y some-mcp@1.2.3 /tmp");
		expect(ports.rpcs).toEqual([
			{
				type: "mcp_add",
				name: "files",
				config: { transport: "stdio", command: "npx", args: ["-y", "some-mcp@1.2.3", "/tmp"] },
				scope: "user",
			},
		]);

		const remote = new FakePorts();
		await control
			.run(CALLER, "extensions.install_mcp", { name: "x", transport: "http", url: "https://mcp.example/api" })
			.catch(() => undefined);
		await new AppControl(remote).run(CALLER, "extensions.install_mcp", {
			name: "docs",
			transport: "http",
			url: "https://mcp.example/api",
			scope: "project",
		});
		expect(remote.cards[0]?.message).toContain("connects to: https://mcp.example/api");
	});

	it("declined, nothing is added; the manage switch does not lift the card (an MCP server is code); env and headers cannot be set; bad shapes are refused", async () => {
		const ports = new FakePorts();
		ports.approve = false;
		const control = new AppControl(ports);
		await refusal(control.run(CALLER, "extensions.install_mcp", { name: "a", transport: "stdio", command: "x" }));
		expect(ports.rpcs).toEqual([]);

		const open = new FakePorts();
		open.manage = true;
		const free = new AppControl(open);
		await free.run(CALLER, "extensions.install_mcp", { name: "a", transport: "stdio", command: "x" });
		expect(open.cards).toHaveLength(1);
		expect(
			await refusal(
				free.run(CALLER, "extensions.install_mcp", {
					name: "a",
					transport: "stdio",
					command: "x",
					env: { K: "v" },
				}),
			),
		).toContain("unknown argument");
		expect(await refusal(free.run(CALLER, "extensions.install_mcp", { name: "a", transport: "stdio" }))).toContain(
			"needs command",
		);
		expect(
			await refusal(
				free.run(CALLER, "extensions.install_mcp", { name: "a", transport: "http", url: "file:///etc/passwd" }),
			),
		).toContain("http(s)");
	});

	it("connects to a tailnet computer after its card, with no card under full control, and blocks a device without one while manage is on", async () => {
		const ports = new FakePorts();
		await new AppControl(ports).run(CALLER, "remote.connect", { nodeId: "nHOST" });
		expect(ports.cards).toHaveLength(1);
		expect(ports.invoked).toEqual([{ channel: IPC_COMMANDS.REMOTE_CONNECT, args: ["nHOST"] }]);

		const full = new FakePorts();
		full.full = true;
		await new AppControl(full).run(CALLER, "remote.connect", { nodeId: "nHOST" });
		expect(full.cards).toEqual([]);

		const declined = new FakePorts();
		declined.approve = false;
		await refusal(new AppControl(declined).run(CALLER, "remote.connect", { nodeId: "nHOST" }));
		expect(declined.invoked).toEqual([]);

		const managed = new FakePorts();
		managed.manage = true;
		await new AppControl(managed).run(CALLER, "remote.block", { deviceId: "dev1" });
		expect(managed.cards).toEqual([]);
		expect(managed.invoked).toEqual([{ channel: IPC_COMMANDS.REMOTE_BLOCK_PEER, args: ["dev1"] }]);
	});

	it("routes Autopilot through ompdesk_autopilot (its card and folder rules), never through set_autopilot", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		expect(await control.run(CALLER, "autopilot.status", { session: "abcd1234" })).toBe("autopilot reply");
		expect(await control.run(CALLER, "autopilot.start", { ship: "push", folder: "/work/repo", device: "PC-B" })).toBe(
			"autopilot reply",
		);
		expect(await control.run(CALLER, "autopilot.stop", { session: "abcd1234", now: true })).toBe("autopilot reply");
		expect(ports.autopilotCalls).toEqual([
			{ action: "status", session: "abcd1234" },
			{ action: "start", folder: "/work/repo", device: "PC-B", ship: "push" },
			{ action: "stop", session: "abcd1234", now: true },
		]);
		expect(ports.rpcs).toEqual([]);
		expect(await refusal(control.run(CALLER, "autopilot.start", { ship: "yolo" }))).toContain("must be one of");
		expect(await refusal(control.run(CALLER, "autopilot.start", { advanced: { cadence: 1 } }))).toContain(
			"unknown argument",
		);
	});

	it("keeps every other autopilot command, and pairing and MCP commands that are not the offered shapes, never", () => {
		for (const action of [
			"start",
			"stop",
			"abort",
			"configure",
			"ship",
			"followup_dismiss",
			"note",
			"pause",
			"resume",
			"cancel_ship",
		])
			expect(rpcTier({ type: "set_autopilot", action } as unknown as RpcCommand), action).toBe("never");
		expect(rpcTier({ type: "get_autopilot" })).toBe("never");
		expect(rpcTier({ type: "mcp_add", name: "a", config: { transport: "stdio", command: "x" } })).toBe("sensitive");
		expect(rpcTier({ type: "mcp_reauth", name: "a" })).toBe("sensitive");
		expect(rpcTier({ type: "get_mcp_servers" })).toBe("read");
		expect(rpcTier({ type: "mcp_action", name: "a", action: "adopt" })).toBe("sensitive");
		for (const action of ["enable", "disable", "reconnect", "remove"] as const)
			expect(rpcTier({ type: "mcp_action", name: "a", action }), action).toBe("never");
		for (const type of ["mcp_test", "mcp_reload", "ssh_manage"])
			expect(rpcTier({ type } as unknown as RpcCommand), type).toBe("never");
	});

	it("tells an agent which MCP servers need a sign-in or are off and why, and starts the sign-in", async () => {
		const ports = new FakePorts();
		ports.full = true;
		const higgsfield = {
			name: "higgsfield",
			transport: "http",
			status: "disconnected",
			toolCount: 0,
			enabled: true,
			authed: false,
			authState: "required",
			url: "https://mcp.example/secret-path",
		};
		const docs = {
			name: "docs",
			transport: "http",
			status: "disconnected",
			toolCount: 0,
			enabled: false,
			authed: false,
			offReason: { kind: "otherTool", tool: "OpenAI Codex", provider: "codex" },
		};
		ports.rpcData = {
			get_mcp_servers: { servers: [higgsfield, docs] },
			mcp_add: { added: true, server: higgsfield },
		};
		const control = new AppControl(ports);
		const listed = await control.run(CALLER, "extensions.mcp_servers", {});
		expect(listed).toContain("higgsfield (http), disconnected, 0 tools, needs sign-in");
		expect(listed).toContain("docs (http), off: found only in OpenAI Codex's config");
		expect(listed).not.toContain("secret-path");

		const added = await control.run(CALLER, "extensions.install_mcp", {
			name: "higgsfield",
			transport: "http",
			url: "https://mcp.example/secret-path",
		});
		expect(added).toContain("needs a sign-in: run extensions.mcp_sign_in");
		expect(added).toContain("Every open session picks the change up");

		ports.rpcData = { ...ports.rpcData, mcp_reauth: { ok: true } };
		const signed = await control.run(CALLER, "extensions.mcp_sign_in", { name: "higgsfield" });
		expect(signed).toContain("Signed in to MCP server higgsfield");
		ports.rpcData = { ...ports.rpcData, mcp_reauth: { ok: false, error: "cancelled" } };
		expect(await refusal(control.run(CALLER, "extensions.mcp_sign_in", { name: "higgsfield" }))).toContain(
			"cancelled",
		);

		ports.rpcData = { ...ports.rpcData, mcp_action: { name: "docs", action: "adopt", from: "OpenAI Codex" } };
		const used = await control.run(CALLER, "extensions.mcp_use", { name: "docs" });
		expect(used).toContain("Copied MCP server docs from OpenAI Codex's config");
		expect(ports.rpcs).toContainEqual({ type: "mcp_action", name: "docs", action: "adopt" });
	});
});

describe("sessions.dump_bundle", () => {
	const saved = {
		ok: true,
		path: "/Users/me/Downloads/omp-dump-2026-10-19-anon.zip",
		files: ["session.jsonl", "ompdesk-diagnostics.txt"],
		subagentCount: 0,
		anonymized: true,
	};
	const dumpPorts = (answer: unknown = saved) => {
		const ports = new FakePorts();
		ports.invoke = async (_tab, channel, args) => {
			ports.invoked.push({ channel, args });
			return answer;
		};
		return ports;
	};

	it("saves this session anonymized to the Downloads folder by default, with no card, and returns the path", async () => {
		const ports = dumpPorts();
		const text = await new AppControl(ports).run(CALLER, "sessions.dump_bundle", {});

		expect(ports.invoked).toEqual([
			{
				channel: IPC_COMMANDS.SESSIONS_DUMP_BUNDLE,
				args: [{ tabId: CALLER, anonymized: true, destination: { kind: "downloads" }, forAgent: true }],
			},
		]);
		expect(text).toContain(saved.path);
		expect(ports.cards).toEqual([]);
		expect(ports.notes).toEqual([`Agent changed: Saved a diagnostic bundle → ${saved.path}`]);
	});

	it("takes the raw transcript only when the agent says so, and another session by its file", async () => {
		const ports = dumpPorts({ ...saved, anonymized: false, path: "/tmp/mine.zip" });
		const text = await new AppControl(ports).run(CALLER, "sessions.dump_bundle", {
			session: "/s/other.jsonl",
			anonymized: false,
			path: "/tmp/mine.zip",
		});

		expect(ports.invoked[0]?.args).toEqual([
			{
				sessionPath: "/s/other.jsonl",
				anonymized: false,
				destination: { kind: "path", path: "/tmp/mine.zip" },
				forAgent: true,
			},
		]);
		expect(text).toContain("/tmp/mine.zip");
		expect(text).not.toContain("anonymized");
	});

	it("names the paired host for a session file of a caller that runs there", async () => {
		const ports = dumpPorts();
		ports.devices[CALLER] = "dev-studio";
		await new AppControl(ports).run(CALLER, "sessions.dump_bundle", { session: "C:/s/other.jsonl" });
		expect(ports.invoked[0]?.args).toEqual([
			{
				sessionPath: "C:/s/other.jsonl",
				device: "dev-studio",
				anonymized: true,
				destination: { kind: "downloads" },
				forAgent: true,
			},
		]);
	});

	it("turns a failed save into a refusal the agent reads", async () => {
		const ports = dumpPorts({ ok: false, error: "There's nothing to save yet.", code: "no_messages" });
		expect(await refusal(new AppControl(ports).run(CALLER, "sessions.dump_bundle", {}))).toBe(
			"There's nothing to save yet.",
		);
	});

	it("is a change: it never reaches the save dialog's channel or any other", async () => {
		expect(ACTION_BY_ID["sessions.dump_bundle"]?.tier).toBe("change");
		const ports = dumpPorts();
		const control = new AppControl(ports);
		await control.run(CALLER, "sessions.dump_bundle", {});
		expect(ports.invoked.map(call => call.channel)).toEqual([IPC_COMMANDS.SESSIONS_DUMP_BUNDLE]);
	});
});

describe("a caller tab on a paired host", () => {
	const HOSTED = "hosted01";
	const STUDIO = "dev-studio";
	const onStudio = (): FakePorts => {
		const ports = new FakePorts();
		ports.devices[HOSTED] = STUDIO;
		ports.manage = true;
		return ports;
	};
	const only = (ports: FakePorts, ...channels: string[]) =>
		ports.invoked.filter(call => channels.includes(call.channel));

	it("sets, reads back and undoes account rotation on that host, never in this computer's prefs", async () => {
		const ports = onStudio();
		ports.prefs.accountRotation = "even";
		const control = new AppControl(ports);

		expect(await control.run(HOSTED, "settings.get", { ids: ["rotation"] })).toContain("rotation: quota");
		await control.run(HOSTED, "settings.rotation", { value: "even" });
		expect(ports.host.rotation).toBe("even");
		expect(only(ports, IPC_COMMANDS.ACCOUNT_ROTATION_SET)).toEqual([
			{ channel: IPC_COMMANDS.ACCOUNT_ROTATION_SET, args: ["even", STUDIO] },
		]);
		expect(await control.run(HOSTED, "settings.get", { ids: ["rotation"] })).toContain("rotation: even");

		await control.run(HOSTED, "app.undo", {});
		expect(ports.host.rotation).toBe("quota");
		expect(only(ports, IPC_COMMANDS.ACCOUNT_ROTATION_SET).at(-1)).toEqual({
			channel: IPC_COMMANDS.ACCOUNT_ROTATION_SET,
			args: ["quota", STUDIO],
		});
		expect(ports.writes).toEqual([]);
		expect(ports.prefs.accountRotation).toBe("even");
		expect(ports.events.filter(event => event.kind === "pref")).toEqual([]);
	});

	it("turns the built-in REA tools on and off on that host", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		await control.run(HOSTED, "settings.builtinRea", { value: false });
		expect(ports.host.rea).toBe(false);
		expect(only(ports, IPC_COMMANDS.BUILTIN_REA_SET)).toEqual([
			{ channel: IPC_COMMANDS.BUILTIN_REA_SET, args: [false, STUDIO] },
		]);
		expect(await control.run(HOSTED, "settings.get", { ids: ["builtinRea"] })).toContain("builtinRea: off");
		await control.run(HOSTED, "app.undo", {});
		expect(ports.host.rea).toBe(true);
		expect(ports.writes).toEqual([]);
	});

	it("still writes a local caller's rotation and REA to this computer's prefs", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.rotation", { value: "even" });
		await control.run(CALLER, "settings.builtinRea", { value: false });
		expect(ports.writes).toEqual([
			{ key: "accountRotation", value: "even" },
			{ key: "builtinMcp.rea", value: false },
		]);
		expect(ports.invoked).toEqual([]);
	});

	it("keeps the card for a sensitive row on a host when agentControlManage is off", async () => {
		const ports = onStudio();
		ports.manage = false;
		ports.approve = false;
		await refusal(new AppControl(ports).run(HOSTED, "settings.rotation", { value: "even" }));
		expect(ports.cards).toHaveLength(1);
		expect(ports.invoked).toEqual([]);
	});

	it("lists, searches, renames and deletes saved sessions on the computer the session runs on", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		await control.run(HOSTED, "sessions.saved", { scope: "local" });
		await control.run(HOSTED, "sessions.search", { query: "retry" });
		await control.run(HOSTED, "sessions.rename", { sessionPath: "/h/a.jsonl", name: "Retry" });
		ports.manage = true;
		ports.approve = true;
		await control.run(HOSTED, "sessions.delete", { sessionPath: "/h/a.jsonl" });
		expect(ports.invoked).toEqual([
			{ channel: IPC_COMMANDS.SESSIONS_LIST, args: [{ scope: "local", device: STUDIO }] },
			{ channel: IPC_COMMANDS.SESSIONS_SEARCH, args: [{ query: "retry", scope: "global", device: STUDIO }] },
			{
				channel: IPC_COMMANDS.SESSIONS_RENAME,
				args: [{ sessionPath: "/h/a.jsonl", name: "Retry", device: STUDIO }],
			},
			{ channel: IPC_COMMANDS.SESSIONS_DELETE, args: [{ sessionPath: "/h/a.jsonl", device: STUDIO }] },
		]);
		expect(ports.cards).toHaveLength(1);

		const local = new FakePorts();
		await new AppControl(local).run(CALLER, "sessions.saved", {});
		expect(local.invoked).toEqual([{ channel: IPC_COMMANDS.SESSIONS_LIST, args: [{ scope: "global" }] }]);
	});

	it("lists the sidebar projects and removes listed ones through the menu's command, reporting an unknown path", async () => {
		const ports = new FakePorts();
		const { list, pushes } = sidebarProjectsOn(
			ports,
			[
				{ path: "/tmp/r1", addedAt: 1 },
				{ path: "/tmp/r2", addedAt: 2 },
				{ path: "/tmp/gone", addedAt: 3, missing: true },
			],
			["/tmp/gone"],
		);
		const control = new AppControl(ports);

		const listed = await control.run(CALLER, "sidebar.projects", {});
		expect(listed).toContain("- /tmp/r1 · r1");
		expect(listed).toContain("- /tmp/gone · gone · folder missing");

		const done = await control.run(CALLER, "sidebar.remove_project", {
			path: "/tmp/r1",
			paths: ["/tmp/r2", "/tmp/nope"],
		});
		expect(done).toContain("Removed from the sidebar: /tmp/r1, /tmp/r2.");
		expect(done).toContain("Not in the sidebar list, left alone: /tmp/nope.");
		expect(list.state().projects.map(project => project.path)).toEqual(["/tmp/gone"]);
		expect(list.state().removed).toEqual(["/tmp/r1", "/tmp/r2"]);
		expect(pushes.at(-1)).toBe(list.state());
		expect(ports.notes).toEqual(["Agent changed: Removed from the sidebar → r1, r2"]);
		expect(ports.cards).toEqual([]);

		const before = list.state();
		const unknown = await refusal(control.run(CALLER, "sidebar.remove_project", { path: "/tmp/nope" }));
		expect(unknown).toContain("Not in the sidebar list, left alone: /tmp/nope.");
		expect(await refusal(control.run(CALLER, "sidebar.remove_project", {}))).toContain("Give path or paths.");
		expect(list.state()).toBe(before);
		expect(ports.invoked.every(call => call.channel === SIDEBAR_PROJECTS_COMMAND)).toBe(true);
		expect(ports.invoked.every(call => call.args.length === 1)).toBe(true);
	});

	it("reads and removes a paired host's sidebar projects on that host", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		ports.invoke = async (_tab, channel, args) => {
			ports.invoked.push({ channel, args });
			return { projects: [{ path: "/h/app", addedAt: 1 }], removed: [], worktrees: {} };
		};
		await control.run(HOSTED, "sidebar.projects", {});
		await control.run(HOSTED, "sidebar.remove_project", { path: "/h/app" });
		expect(ports.invoked).toEqual([
			{ channel: SIDEBAR_PROJECTS_COMMAND, args: [{ action: "get" }, STUDIO] },
			{ channel: SIDEBAR_PROJECTS_COMMAND, args: [{ action: "get" }, STUDIO] },
			{ channel: SIDEBAR_PROJECTS_COMMAND, args: [{ action: "remove", path: "/h/app" }, STUDIO] },
		]);
	});

	it("adds a folder to the sidebar, reporting one already listed, a relative path and a missing folder", async () => {
		const ports = new FakePorts();
		const { list } = sidebarProjectsOn(ports, [{ path: "/tmp/r1", addedAt: 1 }], ["/tmp/nowhere"]);
		const control = new AppControl(ports);

		expect(await control.run(CALLER, "sidebar.add_project", { path: "/tmp/new" })).toContain(
			"Added to the sidebar: /tmp/new.",
		);
		expect(await control.run(CALLER, "sidebar.add_project", { path: "/tmp/r1" })).toBe(
			"/tmp/r1 is already in the sidebar.",
		);
		expect(await control.run(CALLER, "sidebar.add_project", { path: "/tmp/nowhere" })).toContain("shows as missing");
		expect(await control.run(CALLER, "sidebar.add_project", { path: "/work" })).toContain("not added");
		expect(await refusal(control.run(CALLER, "sidebar.add_project", { path: "tmp/rel" }))).toContain("absolute");
		expect(list.state().projects.map(project => project.path)).toEqual(["/tmp/r1", "/tmp/new", "/tmp/nowhere"]);

		await control.run(CALLER, "sidebar.remove_project", { path: "/tmp/new" });
		expect(list.state().removed).toEqual(["/tmp/new"]);
		expect(await control.run(CALLER, "sidebar.add_project", { path: "/tmp/new" })).toContain("Added to the sidebar");
		expect(list.state().removed).toEqual([]);
	});

	it("pins, names and orders listed projects and pins and archives saved sessions through the window, and says what is already so", async () => {
		const ports = new FakePorts();
		sidebarProjectsOn(ports, [
			{ path: "/tmp/a", addedAt: 1 },
			{ path: "/tmp/b", addedAt: 2 },
		]);
		const projectChannel = ports.invoke;
		ports.invoke = async (tab, channel, args) => {
			if (channel !== IPC_COMMANDS.SESSIONS_LIST) return projectChannel(tab, channel, args);
			ports.invoked.push({ channel, args });
			return [{ path: "/s/one.jsonl" }, { path: "/s/two.jsonl" }];
		};
		const control = new AppControl(ports);
		const arranged = () => ports.events.flatMap(event => (event.kind === "sidebar" ? [event.change] : []));

		await control.run(CALLER, "sidebar.pin_project", { path: "/tmp/b", pinned: true });
		await control.run(CALLER, "sidebar.rename_project", { path: "/tmp/a", name: "  Alpha " });
		await control.run(CALLER, "sidebar.order_projects", { paths: ["/tmp/b", "/tmp/a", "/tmp/b"] });
		await control.run(CALLER, "sidebar.pin_session", { sessionPath: "/s/one.jsonl", pinned: true });
		await control.run(CALLER, "sidebar.archive_sessions", { sessionPaths: ["/s/two.jsonl"], archived: true });
		expect(arranged()).toEqual([
			{ op: "pin-project", path: "/tmp/b", pinned: true },
			{ op: "rename-project", path: "/tmp/a", name: "Alpha" },
			{ op: "order-projects", paths: ["/tmp/b", "/tmp/a"] },
			{ op: "pin-session", sessionPath: "/s/one.jsonl", pinned: true },
			{ op: "archive-sessions", sessionPaths: ["/s/two.jsonl"], archived: true },
		]);
		expect(ports.notes).toContain("Agent changed: Pinned a project → b");
		expect(ports.cards).toEqual([]);

		ports.events.length = 0;
		ports.sidebar = {
			pinnedProjects: ["/tmp/b"],
			pinnedSessions: ["/s/one.jsonl"],
			aliases: { "/tmp/a": "Alpha" },
			projectOrder: ["/tmp/b", "/tmp/a"],
		};
		expect(await control.run(CALLER, "sidebar.pin_project", { path: "/tmp/b", pinned: true })).toContain(
			"already pinned",
		);
		expect(await control.run(CALLER, "sidebar.pin_session", { sessionPath: "/s/one.jsonl", pinned: true })).toContain(
			"already pinned",
		);
		expect(await control.run(CALLER, "sidebar.rename_project", { path: "/tmp/a", name: "" })).toContain(
			"folder name",
		);
		expect(arranged()).toEqual([{ op: "rename-project", path: "/tmp/a", name: null }]);
		const listed = await control.run(CALLER, "sidebar.projects", {});
		expect(listed).toContain('- /tmp/a · a · named "Alpha"');
		expect(listed).toContain("- /tmp/b · b · pinned");

		ports.events.length = 0;
		expect(await refusal(control.run(CALLER, "sidebar.pin_project", { path: "/tmp/zzz", pinned: true }))).toContain(
			"Not in the sidebar list, left alone: /tmp/zzz.",
		);
		expect(await refusal(control.run(CALLER, "sidebar.order_projects", { paths: ["/tmp/a", "/tmp/zzz"] }))).toContain(
			"/tmp/zzz",
		);
		expect(
			await refusal(control.run(CALLER, "sidebar.pin_session", { sessionPath: "/s/no.jsonl", pinned: true })),
		).toContain("Not a saved session of this computer: /s/no.jsonl");
		expect(
			await refusal(
				control.run(CALLER, "sidebar.archive_sessions", { sessionPaths: ["/s/no.jsonl"], archived: true }),
			),
		).toContain("/s/no.jsonl");
		expect(arranged()).toEqual([]);
	});

	it("leaves pins, names, order and the archive to this computer's own sidebar when the session runs on a paired host", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		for (const [action, args] of [
			["sidebar.pin_project", { path: "/h/app", pinned: true }],
			["sidebar.rename_project", { path: "/h/app", name: "App" }],
			["sidebar.order_projects", { paths: ["/h/app"] }],
			["sidebar.pin_session", { sessionPath: "/h/a.jsonl", pinned: false }],
			["sidebar.archive_sessions", { sessionPaths: ["/h/a.jsonl"], archived: false }],
		] as const)
			expect(await refusal(control.run(HOSTED, action, args))).toContain("this computer's own sidebar");
		expect(ports.events.filter(event => event.kind === "sidebar")).toEqual([]);
		expect(ports.invoked).toEqual([]);
	});

	it("opens only a named macOS privacy pane, never to toggle it for the person", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		expect(await control.run(CALLER, "ui.open_system_privacy", { pane: "screen_recording" })).toContain(
			"screen recording",
		);
		expect(await control.run(CALLER, "ui.open_system_privacy", { pane: "accessibility" })).toContain("you cannot");
		expect(ports.privacyOpened).toEqual(["screen_recording", "accessibility"]);
		expect(await refusal(control.run(CALLER, "ui.open_system_privacy", { pane: "keychain" }))).toContain("pane");
		expect(ports.privacyOpened).toHaveLength(2);

		ports.privacyError = "Privacy & Security panes exist only on macOS.";
		expect(await refusal(control.run(CALLER, "ui.open_system_privacy", { pane: "camera" }))).toContain(
			"only on macOS",
		);
		expect(ports.cards).toEqual([]);
	});

	it("downloads a found update, asking only while agentControlManage is off, and installs nothing", async () => {
		const ports = new FakePorts();
		ports.approve = false;
		await refusal(new AppControl(ports).run(CALLER, "updates.download", {}));
		expect(ports.cards).toHaveLength(1);
		expect(ports.invoked).toEqual([]);

		const open = new FakePorts();
		open.manage = true;
		expect(await new AppControl(open).run(CALLER, "updates.download", {})).toContain("updates.apply installs it");
		expect(open.invoked).toEqual([{ channel: IPC_COMMANDS.UPDATER_DOWNLOAD, args: [] }]);
		expect(open.cards).toEqual([]);
	});

	it("reads, checks and installs the host's OMPdesk update only when asked, and asks the card to install", async () => {
		const ports = onStudio();
		const control = new AppControl(ports);
		expect(await control.run(HOSTED, "updates.status", { host: true })).toBe(
			"The paired host runs OMPdesk 9.9.9. Update state: idle.",
		);
		await control.run(HOSTED, "updates.check", { host: true });
		await control.run(HOSTED, "updates.status", {});
		await control.run(HOSTED, "updates.check", {});
		expect(ports.invoked).toEqual([
			{ channel: IPC_COMMANDS.HOST_DESKTOP_GET, args: [STUDIO] },
			{ channel: IPC_COMMANDS.HOST_DESKTOP_UPDATE, args: ["check", STUDIO] },
			{ channel: IPC_COMMANDS.UPDATER_GET_STATUS, args: [] },
			{ channel: IPC_COMMANDS.UPDATER_CHECK, args: [] },
		]);

		ports.invoked.length = 0;
		await control.run(HOSTED, "updates.apply", { host: true });
		expect(ports.cards).toHaveLength(1);
		expect(ports.cards[0]?.message).toContain("paired host");
		expect(ports.invoked).toEqual([{ channel: IPC_COMMANDS.HOST_DESKTOP_UPDATE, args: ["install", STUDIO] }]);

		ports.approve = false;
		ports.invoked.length = 0;
		await refusal(control.run(HOSTED, "updates.apply", { host: true }));
		expect(ports.invoked).toEqual([]);
	});

	it("refuses a host update from a session that runs on this computer", async () => {
		const ports = new FakePorts();
		const control = new AppControl(ports);
		for (const id of ["updates.status", "updates.check", "updates.apply"])
			expect(await refusal(control.run(CALLER, id, { host: true })), id).toContain("paired host");
		expect(ports.invoked).toEqual([]);
	});
});
