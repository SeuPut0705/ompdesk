import { afterEach, describe, expect, it } from "vitest";
import { IPC_EVENTS } from "../shared/ipc-types";
import { CORE_EXITED } from "./core/process";
import { routeCoreSaves } from "./core-saves";
import { DiskFullWatch } from "./disk-full";
import { bindDiskFullNotice, bindDiskFullPush } from "./disk-full-notice";

type Listener = (data: unknown, bin: Uint8Array | null) => void;

/** The core's events as main subscribes to them. */
function fakeCore() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		on(event: string, listener: Listener): () => void {
			const set = listeners.get(event) ?? new Set<Listener>();
			listeners.set(event, set);
			set.add(listener);
			return () => set.delete(listener);
		},
		emit(event: string, data: unknown): void {
			for (const listener of [...(listeners.get(event) ?? [])]) listener(data, null);
		},
		count(event: string): number {
			return listeners.get(event)?.size ?? 0;
		},
	};
}

// The watch tells its listeners in a microtask; one more lets them run.
const tick = (): Promise<void> => Promise.resolve();

describe("the core's stores on a full disk", () => {
	const stops: Array<() => void> = [];
	afterEach(() => {
		for (const stop of stops.splice(0)) stop();
	});

	it("join the one notice, which closes when the core says they are saved", async () => {
		const core = fakeCore();
		const watch = new DiskFullWatch();
		const shown: string[] = [];
		let closed = 0;
		stops.push(
			routeCoreSaves(core, watch),
			bindDiskFullNotice(watch, {
				show: notice => {
					shown.push(notice.body);
					return { close: () => closed++ };
				},
				text: names => ({ title: "Disk is full", body: names.join(",") }),
			}),
		);

		core.emit("store.saveFailed", { file: "/data/web-devices.json" });
		core.emit("store.saveFailed", { file: "/data/web-devices.json" });
		core.emit("store.saveFailed", { file: "/data/remote-peers.json" });
		await tick();
		expect(shown).toEqual(["web-devices.json,remote-peers.json"]);
		expect(closed).toBe(0);

		core.emit("store.saved", { file: "/data/web-devices.json" });
		await tick();
		expect(watch.names()).toEqual(["remote-peers.json"]);
		expect(closed).toBe(0);

		core.emit("store.saved", { file: "/data/remote-peers.json" });
		await tick();
		expect(watch.names()).toEqual([]);
		expect(closed).toBe(1);
		expect(shown).toHaveLength(1);
	});

	it("are forgotten when the core ends, since its retries end with it", async () => {
		const core = fakeCore();
		const watch = new DiskFullWatch();
		stops.push(routeCoreSaves(core, watch));
		watch.report("/main/prefs.json");
		core.emit("store.saveFailed", { file: "/data/schedules.json" });
		await tick();
		expect(watch.names()).toEqual(["prefs.json", "schedules.json"]);

		core.emit(CORE_EXITED, null);
		await tick();
		expect(watch.names()).toEqual(["prefs.json"]);
	});

	it("ignore an event that names no file, and stop listening when stopped", () => {
		const core = fakeCore();
		const watch = new DiskFullWatch();
		const stop = routeCoreSaves(core, watch);
		core.emit("store.saveFailed", {});
		core.emit("store.saveFailed", null);
		expect(watch.names()).toEqual([]);
		stop();
		expect(core.count("store.saveFailed")).toBe(0);
		expect(core.count("store.saved")).toBe(0);
		expect(core.count(CORE_EXITED)).toBe(0);
	});
});

describe("the disk-full push to every window and page", () => {
	const target = (destroyed = false) => {
		const sent: Array<[string, unknown]> = [];
		return {
			sent,
			isDestroyed: () => destroyed,
			webContents: { send: (channel: string, data: unknown) => sent.push([channel, data]) },
		};
	};

	it("sends the files that wait, then an empty list, to each live target and none to a destroyed one", async () => {
		const watch = new DiskFullWatch();
		const window = target();
		const phone = target();
		const gone = target(true);
		const stop = bindDiskFullPush(watch, () => [window, phone, gone]);

		watch.report("/data/web-devices.json");
		await tick();
		watch.clear("/data/web-devices.json");
		await tick();
		stop();

		const expected = [
			[IPC_EVENTS.DISK_FULL, { files: ["web-devices.json"] }],
			[IPC_EVENTS.DISK_FULL, { files: [] }],
		];
		expect(window.sent).toEqual(expected);
		expect(phone.sent).toEqual(expected);
		expect(gone.sent).toEqual([]);
	});
});
