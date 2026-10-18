import { describe, expect, it } from "vitest";
import type { AgentAppEvent } from "../../shared/agent-control";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { AppAction } from "./app-catalog";
import { AppControl, type AppPorts, AppRefusal } from "./app-control";
import { prefTier, rpcTier, settingTier } from "./app-guard";
import { NO_ARGS } from "./app-schema";

const CALLER = "main0001";

class FakePorts implements AppPorts {
	prefs: Record<string, unknown> = { themeName: "dark", theme: "dark" };
	manage = false;
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
	note = async (_tab: string, text: string): Promise<void> => {
		this.notes.push(text);
	};
	text = (key: string, params: Record<string, string>): string =>
		key === "appChanged" ? `Agent changed: ${params.what} → ${params.value}` : `${key} ${JSON.stringify(params)}`;
	localize = (en: string): string => en;
	callerTitle = (): string => "Main";
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

	it("runs a sensitive action after the card, and without a card when agentControlManage is on", async () => {
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

		await new AppControl(open).run(CALLER, "updates.apply", {});
		expect(open.invoked).toEqual([{ channel: IPC_COMMANDS.UPDATER_APPLY, args: [] }]);
		expect(open.cards).toEqual([]);
	});

	it("refuses a never action whatever the switch says", async () => {
		const ports = new FakePorts();
		ports.manage = true;
		const control = new AppControl(ports);
		for (const id of ["agent_power.set", "cards.answer", "credentials.read", "remote.pair"])
			expect(await refusal(control.run(CALLER, id, {})), id).toContain("never available");
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
			{ type: "set_autopilot", action: "start" },
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
