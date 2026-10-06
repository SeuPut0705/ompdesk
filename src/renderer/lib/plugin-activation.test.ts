import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { usePluginActivationStore } from "../stores/plugin-activation";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import {
	handlePluginActivation,
	type PluginActivationOrigin,
	restartForActivation,
	watchPluginActivation,
} from "./plugin-activation";
import { resetTabRoute } from "./tab-routing";

const FAST = { verifyAttempts: 2, verifyIntervalMs: 0, wait: async () => {} };
const ORIGIN: PluginActivationOrigin = { tabId: "t1", sessionId: "s1" };
const ENABLED = { pluginId: "demo@market", expected: "enabled" as const };

function activateTab(tabId = "t1", sessionId = "s1"): void {
	useTabsStore.setState({
		tabs: [
			{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false },
			{ id: "t2", cwd: "/w2", status: "ready", kind: "agent", unreadDone: false },
		],
		activeTabId: tabId,
		bundles: new Map(),
	});
	useSessionStore.setState({ sessionId, sessionFile: `/${sessionId}.json`, isStreaming: false, isCompacting: false });
}

afterEach(() => {
	usePluginActivationStore.getState().reset();
	useSessionStore.setState({
		sessionId: undefined,
		sessionFile: null,
		isStreaming: false,
		isCompacting: false,
	});
	useSessionStore.setState({ switchPending: null });
	resetTabRoute();
	vi.restoreAllMocks();
});

function stubOmp(overrides: { restart?: Mock; commandForTab?: Mock } = {}): void {
	(globalThis as unknown as Record<string, unknown>).window = {
		omp: {
			sidecar: { restart: overrides.restart ?? vi.fn(async () => {}) },
			rpc: {
				commandForTab: overrides.commandForTab ?? vi.fn(async () => ({ success: false })),
			},
		},
	};
}

function okPlugins(plugins: unknown): { success: true; data: unknown } {
	return { success: true, data: { plugins } };
}

describe("handlePluginActivation", () => {
	it("restarts and verifies the origin tab when idle", async () => {
		const restart = vi.fn(async () => {});
		const commandForTab = vi.fn(async () => okPlugins([{ id: ENABLED.pluginId, name: "demo", enabled: true }]));
		stubOmp({ restart, commandForTab });
		activateTab();

		await handlePluginActivation("restart-required", ENABLED, ORIGIN, FAST);

		expect(restart).toHaveBeenCalledWith({ tabId: "t1", sessionPath: "/s1.json" });
		expect(commandForTab).toHaveBeenCalledWith("t1", { type: "get_plugins" });
	});

	it("queues every target while streaming and restarts once after settle", async () => {
		const restart = vi.fn(async () => {});
		const commandForTab = vi.fn(async () =>
			okPlugins([
				{ id: "a@market", name: "a", enabled: true },
				{ id: "b@market", name: "b", enabled: true },
			]),
		);
		stubOmp({ restart, commandForTab });
		activateTab();
		useSessionStore.setState({ isStreaming: true });
		await handlePluginActivation("restart-required", { pluginId: "a@market", expected: "enabled" }, ORIGIN, FAST);
		await handlePluginActivation("restart-required", { pluginId: "b@market", expected: "enabled" }, ORIGIN, FAST);
		expect(usePluginActivationStore.getState().pendingByTab.t1?.targets).toHaveLength(2);

		const unwatch = watchPluginActivation();
		useSessionStore.setState({ isStreaming: false });
		await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
		expect(usePluginActivationStore.getState().pendingByTab.t1).toBeUndefined();
		unwatch();
	});

	it("keeps a queued activation bound to its origin tab", async () => {
		const restart = vi.fn(async () => {});
		stubOmp({ restart });
		activateTab();
		useSessionStore.setState({ isStreaming: true });
		await handlePluginActivation("restart-required", ENABLED, ORIGIN, FAST);
		const unwatch = watchPluginActivation();

		activateTab("t2", "s2");

		expect(restart).not.toHaveBeenCalled();
		expect(usePluginActivationStore.getState().pendingByTab.t1).toBeDefined();
		unwatch();
	});

	it("ignores live activations", async () => {
		const restart = vi.fn(async () => {});
		stubOmp({ restart });
		activateTab();
		expect(await handlePluginActivation("live", ENABLED, ORIGIN, FAST)).toBeUndefined();
		expect(restart).not.toHaveBeenCalled();
	});
});

describe("restartForActivation verification", () => {
	it("accepts a disabled or absent plugin for removal", async () => {
		const commandForTab = vi.fn(async () => okPlugins([{ id: "disabled@market", name: "disabled", enabled: false }]));
		stubOmp({ commandForTab });
		activateTab();

		const outcome = await restartForActivation(
			[
				{ pluginId: "disabled@market", expected: "disabled" },
				{ pluginId: "absent@market", expected: "disabled" },
			],
			ORIGIN,
			FAST,
		);

		expect(outcome).toBe("restarted");
	});

	it("reports missing when an enabled target never loads", async () => {
		stubOmp({ commandForTab: vi.fn(async () => okPlugins([])) });
		activateTab();
		expect(await restartForActivation([ENABLED], ORIGIN, FAST)).toBe("missing");
	});
});
