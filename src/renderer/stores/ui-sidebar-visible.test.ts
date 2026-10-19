import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const local = new Map<string, string>();
const set = vi.fn(async (_key: string, _value: unknown) => {});

beforeEach(() => {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => local.get(key) ?? null,
		setItem: (key: string, value: string) => void local.set(key, value),
	});
	vi.stubGlobal("window", { omp: { prefs: { get: vi.fn(async () => undefined), set } } });
});

afterEach(() => {
	local.clear();
	set.mockClear();
	vi.unstubAllGlobals();
	vi.resetModules();
});

/** A relaunch: the store is evaluated again over the same storage. */
async function launch() {
	vi.resetModules();
	return await import("./ui");
}

describe("the docked sidebar's remembered state", () => {
	it("starts open, and a collapse is what the next start (and the boot shell's mirror) sees", async () => {
		const first = await launch();
		expect(first.useUiStore.getState().sidebarVisible).toBe(true);
		first.useUiStore.getState().toggleSidebar();
		expect(local.get("omp.sidebarVisible")).toBe("0");
		expect(set).toHaveBeenCalledWith("sidebarVisible", false);

		const second = await launch();
		expect(second.useUiStore.getState().sidebarVisible).toBe(false);
		second.useUiStore.getState().toggleSidebar();
		expect(local.get("omp.sidebarVisible")).toBe("1");
		expect((await launch()).useUiStore.getState().sidebarVisible).toBe(true);
	});

	it("never saves a drawer's open or closed state, and saves the docked state again when the window docks", async () => {
		const ui = await launch();
		ui.useUiStore.getState().toggleSidebar();
		expect(local.get("omp.sidebarVisible")).toBe("0");
		set.mockClear();

		// Phone / portrait tablet: the drawer opens and closes on the same flag.
		ui.setSidebarDrawerMode(true);
		ui.useUiStore.setState({ sidebarVisible: true });
		ui.useUiStore.setState({ sidebarVisible: false });
		expect(local.get("omp.sidebarVisible")).toBe("0");
		expect(set).not.toHaveBeenCalled();

		// Docked again: the state the window had comes back and is the remembered one.
		ui.setSidebarDrawerMode(false);
		ui.useUiStore.setState({ sidebarVisible: false });
		ui.useUiStore.setState({ sidebarVisible: true });
		expect(local.get("omp.sidebarVisible")).toBe("1");
	});
});
