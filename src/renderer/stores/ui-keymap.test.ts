/**
 * Contract tests for the ui store's keymap override slice (B3): overrides
 * hydrate from the `keymapOverrides` prefs key (sanitized — unknown actions
 * dropped), persist through prefs.set on every mutation, survive a simulated
 * reload, and reset cleanly. Mirror of the input-history store's prefs
 * pattern. GUI-local only — the TUI's keybindings.yml is never involved.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PREFS_BOOT_RETRY_MS } from "../lib/prefs-read";
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

	it("hydrates once", async () => {
		const prefs = installPrefs({ retry: ["⌥⇧R"] });
		await useUiStore.getState().hydrateKeymap();
		await useUiStore.getState().hydrateKeymap();
		expect(prefs.get).toHaveBeenCalledTimes(1);
		expect(useUiStore.getState().keymapOverrides).toEqual({ retry: ["⌥⇧R"] });
	});

	it("persists every mutation and survives a simulated reload", async () => {
		const prefs = installPrefs();
		useUiStore.setState({ keymapHydrated: true });
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
		useUiStore.setState({ keymapHydrated: true });
		useUiStore.getState().setKeymapOverride("tools.expand", ["⇧⌃O"]);
		useUiStore.getState().setKeymapOverride("tools.expand", []);
		expect(useUiStore.getState().keymapOverrides).toEqual({});
		expect(persistedOverrides(prefs)).toEqual({});
	});

	it("resetKeymapOverrides clears everything and persists the empty table", () => {
		const prefs = installPrefs();
		useUiStore.setState({ keymapHydrated: true });
		useUiStore.getState().setKeymapOverride("retry", ["⌃⇧R"]);
		useUiStore.getState().setKeymapOverride("dequeue", ["⌃↓"]);
		useUiStore.getState().resetKeymapOverrides();
		expect(useUiStore.getState().keymapOverrides).toEqual({});
		expect(persistedOverrides(prefs)).toEqual({});
	});
});

describe("ui store keymap overrides with unreadable prefs", () => {
	afterEach(async () => {
		vi.useRealTimers();
		// A read that succeeds replays, and so drains, the edits a test left queued.
		installPrefs();
		await useUiStore.getState().hydrateKeymap();
	});

	/** The boot read against a failing prefs bridge, through every bounded retry. */
	async function failBootRead(): Promise<PrefsMock> {
		vi.useFakeTimers();
		const prefs = installPrefs();
		prefs.get.mockRejectedValue(new Error("no ipc"));
		const hydrating = useUiStore.getState().hydrateKeymap();
		await vi.advanceTimersByTimeAsync(60_000);
		await hydrating;
		return prefs;
	}

	it("stays un-hydrated after a failed read and retries a bounded number of times", async () => {
		const prefs = await failBootRead();
		expect(useUiStore.getState().keymapHydrated).toBe(false);
		expect(prefs.get).toHaveBeenCalledTimes(1 + PREFS_BOOT_RETRY_MS.length);

		prefs.get.mockResolvedValue({ retry: ["⌥⇧R"] });
		await useUiStore.getState().hydrateKeymap();
		expect(useUiStore.getState().keymapHydrated).toBe(true);
		expect(useUiStore.getState().keymapOverrides).toEqual({ retry: ["⌥⇧R"] });
	});

	it("never persists a change over the stored table after a failed read", async () => {
		const prefs = await failBootRead();
		useUiStore.getState().setKeymapOverride("tools.expand", ["⇧⌃O"]);
		useUiStore.getState().resetKeymapOverrides();
		await vi.advanceTimersByTimeAsync(0);
		expect(prefs.set).not.toHaveBeenCalled();
		expect(useUiStore.getState().keymapHydrated).toBe(false);
	});

	it("reads again after a failed read and writes the queued change merged into the stored table", async () => {
		const prefs = await failBootRead();
		prefs.get.mockResolvedValueOnce({ retry: ["⌥⇧R"] });
		useUiStore.getState().setKeymapOverride("tools.expand", ["⇧⌃O"]);
		// The change shows at once; the write waits for the stored table.
		expect(useUiStore.getState().keymapOverrides).toEqual({ "tools.expand": ["⇧⌃O"] });
		expect(prefs.set).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);

		expect(useUiStore.getState().keymapHydrated).toBe(true);
		expect(useUiStore.getState().keymapOverrides).toEqual({ retry: ["⌥⇧R"], "tools.expand": ["⇧⌃O"] });
		expect(prefs.set).toHaveBeenCalledTimes(1);
		expect(persistedOverrides(prefs)).toEqual({ retry: ["⌥⇧R"], "tools.expand": ["⇧⌃O"] });
	});

	it("applies a queued reset-all and a queued removal on top of the stored table", async () => {
		const prefs = await failBootRead();
		prefs.get.mockResolvedValueOnce({ retry: ["⌥⇧R"], dequeue: ["⌃↓"] });
		useUiStore.getState().setKeymapOverride("retry", []);
		await vi.advanceTimersByTimeAsync(0);
		expect(persistedOverrides(prefs)).toEqual({ dequeue: ["⌃↓"] });

		useUiStore.setState({ keymapOverrides: {}, keymapHydrated: false });
		prefs.set.mockClear();
		prefs.get.mockResolvedValueOnce({ retry: ["⌥⇧R"] });
		useUiStore.getState().resetKeymapOverrides();
		await vi.advanceTimersByTimeAsync(0);
		expect(persistedOverrides(prefs)).toEqual({});
	});
});
