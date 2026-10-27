import { describe, expect, it } from "vitest";
import { migrateRetiredPrefs, RETIRED_PREFS } from "./retired-prefs";

/** electron-store's semantics: a dotted key names a nested value. */
function memoryStore(initial: Record<string, unknown>) {
	const data: Record<string, unknown> = structuredClone(initial);
	const parent = (key: string, create: boolean) => {
		const parts = key.split(".");
		let node: Record<string, unknown> | undefined = data;
		for (const part of parts.slice(0, -1)) {
			if (node[part] === undefined && create) node[part] = {};
			node = node[part] as Record<string, unknown> | undefined;
			if (!node || typeof node !== "object") return { node: undefined, last: parts.at(-1) ?? "" };
		}
		return { node, last: parts.at(-1) ?? "" };
	};
	return {
		data,
		has: (key: string) => {
			const { node, last } = parent(key, false);
			return node !== undefined && last in node;
		},
		get: (key: string) => parent(key, false).node?.[parent(key, false).last],
		set: (key: string, value: unknown) => {
			const { node, last } = parent(key, true);
			if (node) node[last] = value;
		},
		delete: (key: string) => {
			const { node, last } = parent(key, false);
			if (node) delete node[last];
		},
	};
}

describe("migrateRetiredPrefs", () => {
	it.each(RETIRED_PREFS.map(entry => entry.key))("drops %s and keeps a live pref", key => {
		const store = memoryStore({ language: "en" });
		store.set(key, false);
		migrateRetiredPrefs(store);
		migrateRetiredPrefs(store);
		expect(store.has(key)).toBe(false);
		expect(store.get("language")).toBe("en");
	});

	it("keeps tools up to date unless all three update switches were off", () => {
		const allOff = memoryStore({ ompAutoUpdate: false, cliAutoUpdate: false, extensionAutoUpdate: false });
		migrateRetiredPrefs(allOff);
		expect(allOff.data).toEqual({ toolsAutoUpdate: false });

		const oneOn = memoryStore({ ompAutoUpdate: false, cliAutoUpdate: true, extensionAutoUpdate: false });
		migrateRetiredPrefs(oneOn);
		expect(oneOn.data).toEqual({});

		const twoOffOneUnset = memoryStore({ ompAutoUpdate: false, cliAutoUpdate: false });
		migrateRetiredPrefs(twoOffOneUnset);
		expect(twoOffOneUnset.data).toEqual({});

		const chosen = memoryStore({
			toolsAutoUpdate: true,
			ompAutoUpdate: false,
			cliAutoUpdate: false,
			extensionAutoUpdate: false,
		});
		migrateRetiredPrefs(chosen);
		expect(chosen.data).toEqual({ toolsAutoUpdate: true });
	});

	it("asks before new devices when either approval switch was on", () => {
		const remoteOn = memoryStore({ remote: { confirmNewDevices: true, keepAwake: false } });
		migrateRetiredPrefs(remoteOn);
		expect(remoteOn.data).toEqual({ remote: { keepAwake: false }, mobileWeb: { confirmNewDevices: true } });

		const webOn = memoryStore({ remote: { confirmNewDevices: false }, mobileWeb: { confirmNewDevices: true } });
		migrateRetiredPrefs(webOn);
		expect(webOn.data).toEqual({ remote: {}, mobileWeb: { confirmNewDevices: true } });

		const bothOff = memoryStore({ remote: { confirmNewDevices: false } });
		migrateRetiredPrefs(bothOff);
		expect(bothOff.get("mobileWeb.confirmNewDevices")).toBeUndefined();
	});

	it("drops the run-state and progress switches and the work board switch, keeping other display preferences", () => {
		const store = memoryStore({
			workBoard: false,
			displayPreferences: { titleState: false, showProgress: true, showTokenUsage: true },
		});
		migrateRetiredPrefs(store);
		expect(store.data).toEqual({ displayPreferences: { showTokenUsage: true } });
	});

	it("forgets a default side panel view and the shortcuts of the views the panel no longer holds", () => {
		const store = memoryStore({
			defaultPanelTab: "jobs",
			keymapOverrides: { "panel.jobs": ["⌥1"], "panel.memory": ["⌥2"], "panel.terminal": ["⌥3"] },
		});
		migrateRetiredPrefs(store);
		migrateRetiredPrefs(store);
		expect(store.data).toEqual({ keymapOverrides: { "panel.terminal": ["⌥3"] } });
		const kept = memoryStore({ defaultPanelTab: "files" });
		migrateRetiredPrefs(kept);
		expect(kept.data).toEqual({ defaultPanelTab: "files" });
	});

	it("writes nothing to prefs that hold no retired key and an already merged value", () => {
		// electron-store rewrites the whole prefs.json on every set and delete, present key or not (~74 ms for 14
		// deletes on a 324 KB file), and this runs on every launch before the first window.
		const store = memoryStore({
			language: "en",
			mobileWeb: { confirmNewDevices: true },
			toolsAutoUpdate: false,
			keymapOverrides: { "panel.terminal": ["⌥3"] },
		});
		let writes = 0;
		const counted = {
			...store,
			set: (key: string, value: unknown) => {
				writes++;
				store.set(key, value);
			},
			delete: (key: string) => {
				writes++;
				store.delete(key);
			},
		};
		migrateRetiredPrefs(counted);
		expect(writes).toBe(0);
		store.set("workBoard", false);
		migrateRetiredPrefs(counted);
		expect(writes).toBe(1);
		expect(store.has("workBoard")).toBe(false);
	});
});
