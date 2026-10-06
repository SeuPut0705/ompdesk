/**
 * Contract tests for the ui store's keymap override slice (B3): overrides
 * hydrate from the `keymapOverrides` prefs key (sanitized — unknown actions
 * dropped), persist through prefs.set on every mutation, survive a simulated
 * reload, and reset cleanly. Mirror of the input-history store's prefs
 * pattern. GUI-local only — the TUI's keybindings.yml is never involved.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { useUiStore } from "./ui";

interface PrefsMock {
	get: Mock<(key?: string) => Promise<unknown>>;
	set: Mock<(key: string, value: unknown) => Promise<void>>;
}

function installPrefs(stored: unknown = undefined): PrefsMock {
	const prefs: PrefsMock = {
		get: vi.fn(async (_key?: string) => stored),
		set: vi.fn(async (_key: string, _value: unknown) => {}),
	};
	// Node test env has no preload bridge; install the mock OmpApi on a global window.
	(globalThis as Record<string, unknown>).window = { omp: { prefs } };
	return prefs;
}

/** Most recent prefs.set() payload for the keymapOverrides key. */
function persistedOverrides(prefs: PrefsMock): unknown {
	const calls = prefs.set.mock.calls;
	if (calls.length === 0) return undefined;
	return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
	useUiStore.setState({ keymapOverrides: {}, keymapHydrated: false });
});

describe("ui store keymap overrides", () => {
	it("hydrates sanitized overrides from prefs", async () => {
		installPrefs({ retry: ["alt+shift+r"], "bogus.action": ["ctrl+q"], "tools.expand": "not-an-array" });
		await useUiStore.getState().hydrateKeymap();
		expect(useUiStore.getState().keymapOverrides).toEqual({ retry: ["⌥⇧R"] });
	});

	it("hydrates once and tolerates prefs IPC failure", async () => {
		const prefs = installPrefs({ retry: ["⌥⇧R"] });
		await useUiStore.getState().hydrateKeymap();
		await useUiStore.getState().hydrateKeymap();
		expect(prefs.get).toHaveBeenCalledTimes(1);
		(globalThis as Record<string, unknown>).window = {
			omp: { prefs: { get: vi.fn(async () => Promise.reject(new Error("no ipc"))) } },
		};
		useUiStore.setState({ keymapOverrides: {}, keymapHydrated: false });
		await useUiStore.getState().hydrateKeymap();
		expect(useUiStore.getState().keymapOverrides).toEqual({});
	});

	it("persists every mutation and survives a simulated reload", async () => {
		const prefs = installPrefs();
		useUiStore.getState().setKeymapOverride("tools.expand", ["⇧⌃O"]);
		expect(useUiStore.getState().keymapOverrides).toEqual({ "tools.expand": ["⇧⌃O"] });
		expect(persistedOverrides(prefs)).toEqual({ "tools.expand": ["⇧⌃O"] });

		// Reload: fresh in-memory state hydrates from the persisted payload.
		const persisted = persistedOverrides(prefs);
		useUiStore.setState({ keymapOverrides: {}, keymapHydrated: false });
		installPrefs(persisted);
		await useUiStore.getState().hydrateKeymap();
		expect(useUiStore.getState().keymapOverrides).toEqual({ "tools.expand": ["⇧⌃O"] });
	});

	it("removes the override (and its prefs entry) on an empty chord list", () => {
		const prefs = installPrefs();
		useUiStore.getState().setKeymapOverride("tools.expand", ["⇧⌃O"]);
		useUiStore.getState().setKeymapOverride("tools.expand", []);
		expect(useUiStore.getState().keymapOverrides).toEqual({});
		expect(persistedOverrides(prefs)).toEqual({});
	});

	it("resetKeymapOverrides clears everything and persists the empty table", () => {
		const prefs = installPrefs();
		useUiStore.getState().setKeymapOverride("retry", ["⌃⇧R"]);
		useUiStore.getState().setKeymapOverride("dequeue", ["⌃↓"]);
		useUiStore.getState().resetKeymapOverrides();
		expect(useUiStore.getState().keymapOverrides).toEqual({});
		expect(persistedOverrides(prefs)).toEqual({});
	});
});
