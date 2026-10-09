/**
 * Single-source command menu: every surface derives one menu from the live
 * stores, and a chat tab (a full agent outside any project) gets the same
 * commands as an agent tab. Exercises the real production entry point
 * (buildCurrentCommandMenu, which reads the tab store) so a surface cannot
 * re-implement the rule and drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableCommand } from "../../shared/rpc-types";
import { useTabsStore } from "../stores/tabs";
import { buildCurrentCommandMenu, type CommandMenuItem, commandArgPrefill } from "./command-registry";
import { translate } from "./i18n";

const SIDECAR_COMMANDS: AvailableCommand[] = [
	// A tool-backed builtin the sidecar advertises but the GUI does not register.
	{ name: "task", description: "Run a task", input: { hint: "<work>" }, textModeExecutable: true },
	// A user command with an argument: the palette must not run it blind.
	{ name: "deploy", description: "Deploy", input: { hint: "<env>" }, textModeExecutable: true },
	// Both names are claimed by a native row (model picker, run-modes window).
	{ name: "models", description: "List models", textModeExecutable: true },
	{ name: "modes", description: "Run modes", textModeExecutable: true },
	// A terminal-only command stays visible so the palette explains its client limit.
	{ name: "terminal-only", description: "Terminal helper", textModeExecutable: false },
];

function seedTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: `t-${kind}`, cwd: "/tmp", status: "ready", kind, unreadDone: false }],
		activeTabId: `t-${kind}`,
	});
}

function menuItem(name: string): CommandMenuItem {
	const item = buildCurrentCommandMenu(SIDECAR_COMMANDS).find(candidate => candidate.name === name);
	if (!item) throw new Error(`missing menu item: ${name}`);
	return item;
}

beforeEach(() => {
	(globalThis as Record<string, unknown>).window = { omp: { rpc: {} }, dispatchEvent: vi.fn() };
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
	useTabsStore.setState({ tabs: [], activeTabId: null });
});

describe("chat-tab availability", () => {
	it("offers GUI-registered tool commands exactly as in an agent tab", () => {
		for (const kind of ["agent", "chat"] as const) {
			seedTab(kind);
			expect(menuItem("plan").affordance.kind, kind).toBe("toggle");
			expect(menuItem("security").affordance.kind, kind).toBe("submenu");
			expect(menuItem("tree").affordance.kind, kind).toBe("window");
			expect(menuItem("git").affordance.kind, kind).toBe("window");
			expect(menuItem("model").affordance.kind, kind).toBe("picker");
		}
	});

	it("keeps a sidecar-advertised tool command executable in a chat tab", () => {
		seedTab("chat");
		expect(menuItem("task").affordance.kind).toBe("prompt");
	});
});

describe("native rows vs sidecar-advertised duplicates", () => {
	it("keeps a terminal-only sidecar command visible but disabled", () => {
		seedTab("agent");
		const item = menuItem("terminal-only");
		if (item.affordance.kind !== "unavailable") throw new Error("terminal-only command is executable");
		expect(item.affordance.reason).toBe(translate("palette.tuiOnly"));
	});

	it("exposes repository changes through the native git row", () => {
		seedTab("agent");
		expect(menuItem("git").affordance.kind).toBe("window");
	});

	it("drops a sidecar row whose name is a native alias instead of listing a dead duplicate", () => {
		seedTab("agent");
		const items = buildCurrentCommandMenu(SIDECAR_COMMANDS);
		expect(items.filter(item => item.name === "models")).toHaveLength(0);
		expect(items.find(item => item.name === "model")?.affordance.kind).toBe("picker");
	});

	it("offers /modes as the run-modes window rather than an unhandled prompt", () => {
		seedTab("agent");
		expect(menuItem("modes").affordance.kind).toBe("window");
	});
});

describe("commandArgPrefill", () => {
	beforeEach(() => seedTab("agent"));

	it("returns the slash form for a parameterized command instead of running it blind", () => {
		expect(commandArgPrefill(menuItem("btw"))).toBe("/btw ");
		expect(commandArgPrefill(menuItem("deploy"))).toBe("/deploy ");
	});

	it("returns null when the row needs no argument", () => {
		// /security export is a fixed prompt the palette can dispatch; /security
		// show takes an id.
		const security = menuItem("security").affordance;
		if (security.kind !== "submenu") throw new Error("security is not a submenu");
		const sub = (name: string): CommandMenuItem => {
			const item = security.items.find(candidate => candidate.name === name);
			if (!item) throw new Error(`missing submenu item: ${name}`);
			return item;
		};
		expect(commandArgPrefill(sub("security show"))).toBe("/security show ");
		expect(commandArgPrefill(sub("security export"))).toBeNull();
		expect(commandArgPrefill(menuItem("model"))).toBeNull();
		expect(commandArgPrefill(menuItem("compact"))).toBeNull();
	});
});
