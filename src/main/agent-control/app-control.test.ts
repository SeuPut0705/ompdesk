import { describe, expect, it } from "vitest";
import type { AgentAppEvent } from "../../shared/agent-control";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { WEB_BLOCKS_LIST } from "../../shared/mobile-web";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
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

	getPref = (key: string): unknown => this.prefs[key];
	setPref = async (_tab: string, key: string, value: unknown): Promise<void> => {
		this.prefs[key] = value;
		this.writes.push({ key, value });
	};
	rpc = async (_tab: string, command: RpcCommand): Promise<RpcResponse> => {
		this.rpcs.push(command);
		if (command.type === "get_settings")
			return { type: "response", success: true, data: { values: this.stock } } as RpcResponse;
		if (command.type === "set_setting") this.stock[command.path] = command.value;
		return { type: "response", success: true, data: {} } as RpcResponse;
	};
	invoke = async (_tab: string, channel: string, args: readonly unknown[]): Promise<unknown> => {
		this.invoked.push({ channel, args });
		if (channel === WEB_BLOCKS_LIST) return [{ id: "node:nHOST", scope: "node", name: "Studio" }];
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
	callerTitle = (): string => "Main";
	autopilotCalls: unknown[] = [];
	autopilot = async (_tab: string, args: unknown): Promise<string> => {
		this.autopilotCalls.push(args);
		return "autopilot reply";
	};
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
		await control.run(CALLER, "settings.cliAutoUpdate", { value: true });
		expect(ports.cards).toHaveLength(1);
		expect(ports.prefs.cliAutoUpdate).toBe(true);

		const open = new FakePorts();
		open.manage = true;
		await new AppControl(open).run(CALLER, "settings.cliAutoUpdate", { value: true });
		expect(open.cards).toEqual([]);
		expect(open.prefs.cliAutoUpdate).toBe(true);

		await new AppControl(open).run(CALLER, "updates.check", {});
		expect(open.invoked).toEqual([{ channel: IPC_COMMANDS.UPDATER_CHECK, args: [] }]);
		expect(open.cards).toEqual([]);
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
		ports.prefs.cliAutoUpdate = false;
		const control = new AppControl(ports);
		await control.run(CALLER, "settings.cliAutoUpdate", { value: true });
		ports.approve = false;
		expect(await refusal(control.run(CALLER, "app.undo", {}))).toContain("declined");
		expect(ports.prefs.cliAutoUpdate).toBe(true);
	});
});

describe("what agents can never reach, by any route", () => {
	const POWER = [
		"agentControl",
		"agentControlManage",
		"agentControlApprove",
		"approvalMode",
		"pstack",
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
				await ctx.setPref("cliAutoUpdate", true);
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
		expect(await control.run(CALLER, "autopilot.start", { ship: "push", folder: "/work/repo" })).toBe(
			"autopilot reply",
		);
		expect(await control.run(CALLER, "autopilot.stop", { session: "abcd1234", now: true })).toBe("autopilot reply");
		expect(ports.autopilotCalls).toEqual([
			{ action: "status", session: "abcd1234" },
			{ action: "start", folder: "/work/repo", ship: "push" },
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
			"backlog_add",
			"note",
			"pause",
			"resume",
			"guide_draft",
			"cancel_ship",
		])
			expect(rpcTier({ type: "set_autopilot", action } as unknown as RpcCommand), action).toBe("never");
		expect(rpcTier({ type: "get_autopilot" })).toBe("never");
		expect(rpcTier({ type: "mcp_add", name: "a", config: { transport: "stdio", command: "x" } })).toBe("sensitive");
		for (const type of ["mcp_test", "mcp_reauth", "ssh_manage"])
			expect(rpcTier({ type } as unknown as RpcCommand), type).toBe("never");
	});
});
