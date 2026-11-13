import ElectronStore from "electron-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diskFull } from "./disk-full";
import { SafeStore } from "./safe-store";

const disk = vi.hoisted(() => ({ code: null as string | null, files: new Map<string, string>() }));

// conf reads the file on every `store` read and writes it whole on every `store` write, which every get and set goes
// through; this stands in for it with a disk that can be full, so the test needs no real ENOSPC.
vi.mock("electron-store", () => {
	class FakeStore<T extends Record<string, unknown>> {
		readonly path: string;
		readonly events = new EventTarget();
		constructor(options: { name: string }) {
			this.path = `/fake/${options.name}.json`;
		}
		get store(): T {
			return JSON.parse(disk.files.get(this.path) ?? "{}") as T;
		}
		set store(value: T) {
			if (disk.code) throw Object.assign(new Error(`${disk.code}: the disk refused the write`), { code: disk.code });
			disk.files.set(this.path, JSON.stringify(value));
			this.events.dispatchEvent(new Event("change"));
		}
		get(key: string): unknown {
			return (this.store as Record<string, unknown>)[key];
		}
		set(key: string, value: unknown): void {
			const store = this.store as Record<string, unknown>;
			store[key] = value;
			this.store = store as T;
		}
	}
	return { default: FakeStore };
});

describe("prefs written on a full disk", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		disk.files.set("/fake/prefs.json", JSON.stringify({ theme: "dark" }));
	});
	afterEach(async () => {
		disk.code = null;
		// What a test left waiting is dropped by saving it.
		await vi.advanceTimersByTimeAsync(60_000);
		disk.files.clear();
		vi.useRealTimers();
	});

	it("a plain store throws ENOSPC into its caller", () => {
		disk.code = "ENOSPC";
		expect(() => new ElectronStore({ name: "prefs" }).set("language", "ko")).toThrow(/ENOSPC/);
	});

	it("keeps the value in memory for every store on the file and leaves the file as it was", async () => {
		const prefs = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		const other = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		disk.code = "ENOSPC";

		expect(() => prefs.set("language", "ko")).not.toThrow();
		expect(prefs.get("language")).toBe("ko");
		expect(other.get("language")).toBe("ko");
		expect(other.get("theme")).toBe("dark");
		expect(JSON.parse(disk.files.get("/fake/prefs.json") ?? "")).toEqual({ theme: "dark" });
		await vi.advanceTimersByTimeAsync(0);
		expect(diskFull.names()).toEqual(["prefs.json"]);
	});

	it("saves the newest whole store once the space is back, and the notice ends", async () => {
		const prefs = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		disk.code = "ENOSPC";
		prefs.set("language", "ko");
		prefs.set("proxyUrl", "http://proxy");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(JSON.parse(disk.files.get("/fake/prefs.json") ?? "")).toEqual({ theme: "dark" });

		disk.code = null;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(JSON.parse(disk.files.get("/fake/prefs.json") ?? "")).toEqual({
			theme: "dark",
			language: "ko",
			proxyUrl: "http://proxy",
		});
		expect(diskFull.names()).toEqual([]);
	});

	it("a set that finds room saves at once and takes what waited with it", async () => {
		const prefs = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		disk.code = "ENOSPC";
		prefs.set("language", "ko");
		disk.code = null;
		prefs.set("proxyUrl", "http://proxy");
		expect(JSON.parse(disk.files.get("/fake/prefs.json") ?? "")).toEqual({
			theme: "dark",
			language: "ko",
			proxyUrl: "http://proxy",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(diskFull.names()).toEqual([]);
	});

	it("tells a listener the store changed even though the file did not", () => {
		const prefs = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		const changed = vi.fn();
		prefs.events.addEventListener("change", changed);
		disk.code = "ENOSPC";
		prefs.set("language", "ko");
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("still throws a failure that is not a full disk", () => {
		const prefs = new SafeStore<Record<string, unknown>>({ name: "prefs" });
		disk.code = "EACCES";
		expect(() => prefs.set("language", "ko")).toThrow(/EACCES/);
		expect(prefs.get("language")).toBeUndefined();
	});
});
