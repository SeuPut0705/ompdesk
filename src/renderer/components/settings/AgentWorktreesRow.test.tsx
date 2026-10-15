/**
 * Settings › Worktrees › Agent worktrees: lists stock `omp worktree list`,
 * cleans up only through stock's orphan-only clear, says what happened, and
 * the auto-clean switch writes the pref main reads.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcAgentWorktree, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { AgentWorktreesRows } from "./AgentWorktreesRow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

const LIVE: RpcAgentWorktree = { path: "/u/.omp/wt/pr-7", kind: "pr-checkout", parentRepo: "/repo", branch: "pr-7" };
const ORPHAN: RpcAgentWorktree = { path: "/u/.omp/wt/task-1", kind: "task-isolation", orphanReason: "owner gone" };

const getAgentWorktrees = vi.fn(async (): Promise<RpcResponse> => ok("get_agent_worktrees", { entries: [] }));
const clearAgentWorktrees = vi.fn(
	async (): Promise<RpcResponse> =>
		ok("clear_agent_worktrees", { removed: 1, failed: 0, results: [{ path: ORPHAN.path, ok: true }] }),
);
const prefs = new Map<string, unknown>();
const prefsSet = vi.fn(async (key: string, value: unknown) => {
	prefs.set(key, value);
});

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: { getAgentWorktrees, clearAgentWorktrees },
		prefs: { get: vi.fn(async (key: string) => prefs.get(key)), set: prefsSet },
	},
});

const roots: Root[] = [];

beforeEach(() => {
	useSessionStore.setState({ status: "ready" });
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	getAgentWorktrees.mockReset();
	clearAgentWorktrees.mockClear();
	prefsSet.mockClear();
	prefs.clear();
	useSessionStore.getState().reset();
});

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<AgentWorktreesRows />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

function button(label: string): HTMLButtonElement | undefined {
	return (Array.from(document.body.querySelectorAll("button")) as HTMLButtonElement[]).find(
		item => (item.textContent ?? "").trim() === label,
	);
}

describe("AgentWorktreesRows", () => {
	it("lists the orphaned worktrees, cleans them through stock's clear and reloads", async () => {
		getAgentWorktrees
			.mockResolvedValueOnce(ok("get_agent_worktrees", { entries: [LIVE, ORPHAN] }))
			.mockResolvedValueOnce(ok("get_agent_worktrees", { entries: [LIVE] }));
		await mount();
		const text = () => document.body.textContent ?? "";
		expect(text()).toContain(translate("settings.agentWorktrees.summary", { total: 2, orphaned: 1 }));
		expect(document.querySelector(`[data-orphan="${ORPHAN.path}"]`)?.textContent).toContain("owner gone");
		// A live checkout is counted, never offered for removal.
		expect(document.querySelector(`[data-orphan="${LIVE.path}"]`)).toBeNull();

		await act(async () => {
			button(translate("settings.agentWorktrees.clear"))?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(clearAgentWorktrees).toHaveBeenCalledTimes(1);
		expect(text()).toContain(translate("settings.agentWorktrees.cleared", { count: 1 }));
		expect(text()).toContain(translate("settings.agentWorktrees.summary", { total: 1, orphaned: 0 }));
		expect(button(translate("settings.agentWorktrees.clear"))?.disabled).toBe(true);
	});

	it("names the worktrees stock could not remove", async () => {
		getAgentWorktrees.mockResolvedValue(ok("get_agent_worktrees", { entries: [ORPHAN] }));
		clearAgentWorktrees.mockResolvedValueOnce(
			ok("clear_agent_worktrees", {
				removed: 0,
				failed: 1,
				results: [{ path: ORPHAN.path, ok: false, error: "EBUSY" }],
			}),
		);
		await mount();
		await act(async () => {
			button(translate("settings.agentWorktrees.clear"))?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("settings.agentWorktrees.clearedSome", { removed: 0, failed: 1 }));
		expect(text).toContain(`${ORPHAN.path} — EBUSY`);
	});

	it("shows omp's failure instead of an empty list", async () => {
		getAgentWorktrees.mockResolvedValue({
			type: "response",
			command: "get_agent_worktrees",
			success: false,
			error: "Unknown command: worktree",
		});
		await mount();
		const text = document.body.textContent ?? "";
		expect(text).toContain("Unknown command: worktree");
		expect(text).not.toContain(translate("settings.agentWorktrees.none"));
	});

	it("saves the auto-clean switch as the pref main reads", async () => {
		getAgentWorktrees.mockResolvedValue(ok("get_agent_worktrees", { entries: [] }));
		await mount();
		expect(document.body.textContent ?? "").toContain(translate("settings.agentWorktrees.none"));
		const toggle = document.querySelector("#setting-gui-worktreeAutoClean [role='switch']") as HTMLButtonElement;
		await act(async () => {
			toggle.click();
		});
		expect(prefsSet).toHaveBeenCalledWith("worktreeAutoClean", true);
	});
});
