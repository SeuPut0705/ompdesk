import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appGoneMoment,
	CHUNK_RELOAD_KEY,
	CHUNK_RELOAD_LOOP_MS,
	chunkReloadRepeats,
	PURGE_CLEANUP_MS,
	purgeAndReload,
	RESUME_AFTER_HIDDEN_MS,
	RESUME_WINDOW_MS,
	type RegistrationLike,
	ResumeGate,
	reloadWhenUnused,
	type SafeMoment,
	safeToReload,
	UpdateWatcher,
	type WorkerContainerLike,
	type WorkerLike,
} from "./sw-update";

class FakeWorker implements WorkerLike {
	state = "installing";
	readonly messages: unknown[] = [];
	readonly #listeners: (() => void)[] = [];
	postMessage(message: unknown): void {
		this.messages.push(message);
	}
	addEventListener(_type: "statechange", listener: () => void): void {
		this.#listeners.push(listener);
	}
	become(state: string): void {
		this.state = state;
		for (const listener of this.#listeners) listener();
	}
}

class FakeRegistration implements RegistrationLike {
	waiting: WorkerLike | null = null;
	installing: WorkerLike | null = null;
	updates = 0;
	failUpdate = false;
	#found: (() => void) | null = null;
	addEventListener(_type: "updatefound", listener: () => void): void {
		this.#found = listener;
	}
	async update(): Promise<void> {
		this.updates++;
		if (this.failUpdate) throw new TypeError("offline");
	}
	async unregister(): Promise<boolean> {
		return true;
	}
	found(worker: FakeWorker): void {
		this.installing = worker;
		this.#found?.();
	}
}

class FakeContainer implements WorkerContainerLike {
	controller: unknown = {};
	#changed: (() => void) | null = null;
	addEventListener(_type: "controllerchange", listener: () => void): void {
		this.#changed = listener;
	}
	takeOver(): void {
		this.#changed?.();
	}
}

describe("UpdateWatcher", () => {
	it("is available at once when a worker already waits behind a controlling one", () => {
		const registration = new FakeRegistration();
		registration.waiting = new FakeWorker();
		expect(new UpdateWatcher(registration, new FakeContainer(), () => {}).available).toBe(true);
	});

	it("is not available on the first install (no controller to replace)", () => {
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		container.controller = null;
		const watcher = new UpdateWatcher(registration, container, () => {});
		const worker = new FakeWorker();
		registration.found(worker);
		worker.become("installed");
		expect(watcher.available).toBe(false);
	});

	it("is not available when a first install's 'installed' event arrives after the worker already took control", () => {
		// A first install's "installed" event can reach the page after the worker activated and claimed it. Nothing
		// waits then; taking it as an update reloads a phone's first visit right after pairing.
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		container.controller = null;
		const watcher = new UpdateWatcher(registration, container, () => {});
		const worker = new FakeWorker();
		registration.found(worker);
		container.controller = worker;
		worker.become("installed");
		expect(watcher.available).toBe(false);
	});

	it("is not available when the worker that finished installing is already the page's controller (WebKit's order)", () => {
		// Recorded on a hosted runner's WebKit right after pairing (nightly 39533946034): at the first install's
		// "installed" event the registration still named the worker `waiting` and the page's controller was that same
		// worker; "activating" and `controllerchange` came in the same millisecond. Nothing older is replaced.
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		container.controller = null;
		const watcher = new UpdateWatcher(registration, container, () => {});
		const worker = new FakeWorker();
		registration.found(worker);
		registration.waiting = worker;
		container.controller = worker;
		worker.become("installed");
		expect(watcher.available).toBe(false);
		// A page that loads in that moment sees the same pair: no update either.
		expect(new UpdateWatcher(registration, container, () => {}).available).toBe(false);
	});

	it("becomes available when a new worker finishes installing, and tells listeners", () => {
		const registration = new FakeRegistration();
		const watcher = new UpdateWatcher(registration, new FakeContainer(), () => {});
		const changed = vi.fn();
		watcher.onChange(changed);
		const worker = new FakeWorker();
		registration.found(worker);
		worker.become("installing");
		expect(watcher.available).toBe(false);
		// The browser sets the registration's waiting worker before it dispatches "installed".
		registration.waiting = worker;
		worker.become("installed");
		expect(watcher.available).toBe(true);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("applies by asking the waiting worker to skip waiting and reloads when it takes over", () => {
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		const reload = vi.fn();
		const waiting = new FakeWorker();
		registration.waiting = waiting;
		const watcher = new UpdateWatcher(registration, container, reload);
		container.takeOver();
		expect(reload).not.toHaveBeenCalled();
		watcher.apply();
		expect(waiting.messages).toEqual([{ type: "skip-waiting" }]);
		expect(reload).not.toHaveBeenCalled();
		container.takeOver();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads directly when nothing waits", () => {
		const reload = vi.fn();
		new UpdateWatcher(new FakeRegistration(), new FakeContainer(), reload).apply();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("checks for a new worker and never throws offline", async () => {
		const registration = new FakeRegistration();
		const watcher = new UpdateWatcher(registration, new FakeContainer(), () => {});
		await watcher.check();
		registration.failUpdate = true;
		await expect(watcher.check()).resolves.toBeUndefined();
		expect(registration.updates).toBe(2);
	});
});

const calm: SafeMoment = {
	visible: () => true,
	draftEmpty: () => true,
	attached: () => false,
	picking: () => false,
	askOpen: () => false,
	uploading: () => false,
	editing: () => false,
};
const moment = (over: Partial<Record<keyof SafeMoment, boolean>>): SafeMoment => ({
	visible: () => over.visible ?? true,
	draftEmpty: () => over.draftEmpty ?? true,
	attached: () => over.attached ?? false,
	picking: () => over.picking ?? false,
	askOpen: () => over.askOpen ?? false,
	uploading: () => over.uploading ?? false,
	editing: () => over.editing ?? false,
});

describe("safeToReload", () => {
	it("is only a foreground page with an empty draft, no file pick, no open question and no upload", () => {
		expect(safeToReload(calm)).toBe(true);
		expect(safeToReload(moment({ visible: false }))).toBe(false);
		expect(safeToReload(moment({ draftEmpty: false }))).toBe(false);
		expect(safeToReload(moment({ picking: true }))).toBe(false);
		expect(safeToReload(moment({ askOpen: true }))).toBe(false);
		expect(safeToReload(moment({ uploading: true }))).toBe(false);
		expect(safeToReload(moment({ editing: true }))).toBe(false);
	});
});

describe("ResumeGate (an update or last-resort reload lands only while the page is not in use)", () => {
	it("opens at launch and closes at the first touch or key", () => {
		const gate = new ResumeGate();
		expect(gate.open(0)).toBe(false);
		gate.launched(1000);
		expect(gate.open(1000)).toBe(true);
		gate.used();
		expect(gate.open(1001)).toBe(false);
	});

	it("lasts the resume window only", () => {
		const gate = new ResumeGate();
		gate.launched(0);
		expect(gate.open(RESUME_WINDOW_MS - 1)).toBe(true);
		expect(gate.open(RESUME_WINDOW_MS)).toBe(false);
	});

	it("opens again on a return after at least 30 s hidden, never after a quick glance away", () => {
		const gate = new ResumeGate();
		gate.launched(0);
		gate.used();
		gate.hidden(1000);
		expect(gate.shown(1000 + RESUME_AFTER_HIDDEN_MS - 1)).toBe(false);
		expect(gate.open(1000 + RESUME_AFTER_HIDDEN_MS)).toBe(false);
		gate.hidden(100_000);
		expect(gate.shown(100_000 + RESUME_AFTER_HIDDEN_MS)).toBe(true);
		expect(gate.open(100_000 + RESUME_AFTER_HIDDEN_MS + 10)).toBe(true);
	});

	it("is closed while hidden, and a second hide keeps the first hide's time", () => {
		const gate = new ResumeGate();
		gate.launched(0);
		gate.hidden(10);
		expect(gate.open(11)).toBe(false);
		gate.hidden(25_000);
		expect(gate.shown(10 + RESUME_AFTER_HIDDEN_MS)).toBe(true);
	});
});

describe("chunkReloadRepeats (a chunk that keeps failing never reloads the page at every launch)", () => {
	const storage = (value: string | null) => ({ getItem: (key: string) => (key === CHUNK_RELOAD_KEY ? value : null) });

	it("is false for a page that never reloaded for a chunk", () => {
		expect(chunkReloadRepeats(storage(null), 1_000_000)).toBe(false);
	});

	it("is true while the last reload for a chunk is recent, and false once it is old", () => {
		const at = 1_000_000;
		expect(chunkReloadRepeats(storage(String(at)), at + 250)).toBe(true);
		expect(chunkReloadRepeats(storage(String(at)), at + CHUNK_RELOAD_LOOP_MS - 1)).toBe(true);
		expect(chunkReloadRepeats(storage(String(at)), at + CHUNK_RELOAD_LOOP_MS)).toBe(false);
	});

	it("reads a damaged value as no reload", () => {
		expect(chunkReloadRepeats(storage("garbage"), 1_000_000)).toBe(false);
	});
});

describe("reloadWhenUnused (the last resort after the in-place resync kept failing)", () => {
	afterEach(() => vi.useRealTimers());
	const openGate = { open: () => true };
	const closedGate = { open: () => false };

	it("reloads at once a hidden page, even with typed text or an open question", () => {
		const reload = vi.fn();
		reloadWhenUnused(moment({ visible: false, draftEmpty: false, askOpen: true }), closedGate, reload);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("never reloads a visible page in use (read, scrolled or typed in since its last moment)", () => {
		vi.useFakeTimers();
		const reload = vi.fn();
		reloadWhenUnused(calm, closedGate, reload);
		vi.advanceTimersByTime(60_000);
		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads a visible page at a launch or return moment only when nothing is typed or open", () => {
		vi.useFakeTimers();
		const typed = { draftEmpty: false };
		const reload = vi.fn();
		reloadWhenUnused(moment(typed), openGate, reload);
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		typed.draftEmpty = true;
		vi.advanceTimersByTime(500);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a file pick is in progress (the page just came back from the phone's picker)", "picking"],
		["the composer holds a picture", "attached"],
		["an upload is on its way", "uploading"],
		["an edit is unsaved", "editing"],
	] as const)("waits even while hidden when %s, then reloads once", (_name, key) => {
		vi.useFakeTimers();
		const busy = { visible: false, [key]: true };
		const reload = vi.fn();
		reloadWhenUnused(moment(busy), closedGate, reload);
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		busy[key] = false;
		vi.advanceTimersByTime(500);
		expect(reload).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("looks again when asked (the page's visibility changed) and can be cancelled", () => {
		vi.useFakeTimers();
		const page = { visible: true };
		const reload = vi.fn();
		const pending = reloadWhenUnused(moment(page), closedGate, reload, { everyMs: 60_000 });
		page.visible = false;
		pending.recheck();
		expect(reload).toHaveBeenCalledTimes(1);
		const other = vi.fn();
		reloadWhenUnused(moment({ picking: true }), closedGate, other).cancel();
		vi.advanceTimersByTime(5000);
		expect(other).not.toHaveBeenCalled();
	});
});

describe("UpdateWatcher.resume (updates apply by themselves)", () => {
	function waiting() {
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		const worker = new FakeWorker();
		registration.waiting = worker;
		const reload = vi.fn();
		const purge = vi.fn();
		return { watcher: new UpdateWatcher(registration, container, reload, purge), container, worker, reload, purge };
	}

	it("does nothing while nothing is pending", () => {
		const reload = vi.fn();
		const purge = vi.fn();
		const watcher = new UpdateWatcher(new FakeRegistration(), new FakeContainer(), reload, purge);
		expect(watcher.pending).toBe(false);
		expect(watcher.resume(calm)).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		expect(purge).not.toHaveBeenCalled();
	});

	it("skips waiting at a safe moment and reloads once the new worker controls the page", () => {
		const { watcher, container, worker, reload, purge } = waiting();
		expect(watcher.resume(calm)).toBe(true);
		expect(worker.messages).toEqual([{ type: "skip-waiting" }]);
		expect(reload).not.toHaveBeenCalled();
		container.takeOver();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(purge).not.toHaveBeenCalled();
	});

	it.each([
		["the page is hidden", { visible: false }],
		["the composer holds a draft", { draftEmpty: false }],
		["an ask card is open", { askOpen: true }],
		["an upload is in flight", { uploading: true }],
		["a file pick is in progress", { picking: true }],
		["a file or sheet holds unsaved edits", { editing: true }],
	] as const)("waits when %s, and applies at the next safe moment", (_name, busy) => {
		const { watcher, worker } = waiting();
		expect(watcher.resume(moment(busy))).toBe(false);
		expect(worker.messages).toEqual([]);
		expect(watcher.pending).toBe(true);
		expect(watcher.resume(calm)).toBe(true);
		expect(worker.messages).toEqual([{ type: "skip-waiting" }]);
	});

	it("applies a build that finished installing after launch at the next resume", () => {
		const registration = new FakeRegistration();
		const container = new FakeContainer();
		const watcher = new UpdateWatcher(registration, container, vi.fn());
		expect(watcher.resume(calm)).toBe(false);
		const worker = new FakeWorker();
		registration.found(worker);
		registration.waiting = worker;
		worker.become("installed");
		expect(watcher.pending).toBe(true);
		expect(watcher.resume(calm)).toBe(true);
		expect(worker.messages).toEqual([{ type: "skip-waiting" }]);
	});

	it("purges and reloads an outdated page under the same rule, with no worker waiting", () => {
		const reload = vi.fn();
		const purge = vi.fn();
		const watcher = new UpdateWatcher(new FakeRegistration(), new FakeContainer(), reload, purge);
		watcher.markOutdated();
		expect(watcher.pending).toBe(true);
		expect(watcher.resume(moment({ draftEmpty: false }))).toBe(false);
		expect(purge).not.toHaveBeenCalled();
		expect(watcher.resume(calm)).toBe(true);
		expect(purge).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
	});

	it("starts one reload, however many resumes follow", () => {
		const { watcher, worker } = waiting();
		expect(watcher.resume(calm)).toBe(true);
		expect(watcher.resume(calm)).toBe(false);
		expect(worker.messages).toHaveLength(1);
	});
});

describe("purgeAndReload", () => {
	it("unregisters every worker, deletes every cache and reloads", async () => {
		const unregister = vi.fn(async () => true);
		const deleted: string[] = [];
		const reload = vi.fn();
		await purgeAndReload(
			{ getRegistrations: async () => [{ unregister }, { unregister }] },
			{
				keys: async () => ["omp-shell-a", "other"],
				delete: async name => {
					deleted.push(name);
					return true;
				},
			},
			reload,
		);
		expect(unregister).toHaveBeenCalledTimes(2);
		expect(deleted).toEqual(["omp-shell-a", "other"]);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads even when there is no worker API or cleanup fails", async () => {
		const reload = vi.fn();
		await purgeAndReload(undefined, undefined, reload);
		expect(reload).toHaveBeenCalledTimes(1);
		await expect(
			purgeAndReload(
				{
					getRegistrations: async () => {
						throw new Error("blocked");
					},
				},
				undefined,
				reload,
			),
		).resolves.toBe(true);
		expect(reload).toHaveBeenCalledTimes(2);
	});

	it("reloads after its cleanup budget when a cache delete never settles", async () => {
		vi.useFakeTimers();
		try {
			const reload = vi.fn();
			const unregister = vi.fn(async () => true);
			const pending = purgeAndReload(
				{ getRegistrations: async () => [{ unregister }] },
				{ keys: async () => ["omp-assets-a"], delete: () => new Promise<boolean>(() => {}) },
				reload,
			);
			await vi.advanceTimersByTimeAsync(PURGE_CLEANUP_MS - 1);
			expect(unregister).toHaveBeenCalledTimes(1);
			expect(reload).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(reload).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the purge done but does not reload when the page stopped being safe during the cleanup", async () => {
		const page = { draftEmpty: true };
		const reload = vi.fn();
		const gate = Promise.withResolvers<boolean>();
		const unregister = vi.fn(async () => gate.promise);
		const purges: Promise<boolean>[] = [];
		const watcher = new UpdateWatcher(new FakeRegistration(), new FakeContainer(), vi.fn(), () => {
			const purge = purgeAndReload({ getRegistrations: async () => [{ unregister }] }, undefined, reload, () =>
				safeToReload(moment(page)),
			);
			purges.push(purge);
			return purge;
		});
		watcher.markOutdated();
		expect(watcher.resume(moment(page))).toBe(true);
		page.draftEmpty = false;
		gate.resolve(true);
		await purges[0];
		expect(unregister).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
		expect(watcher.resume(moment(page))).toBe(false);
		page.draftEmpty = true;
		expect(watcher.resume(moment(page))).toBe(true);
		await purges[1];
		expect(reload).toHaveBeenCalledTimes(1);
		expect(watcher.resume(moment(page))).toBe(false);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe("appGoneMoment (a chunk error took the whole app down: the root boundary's stale page)", () => {
	afterEach(() => vi.useRealTimers());
	const openGate = { open: () => true };

	it("lets the saved text go but never a picture or an unsaved edit, hidden or at a return moment", () => {
		vi.useFakeTimers();
		const page = { visible: false, draftEmpty: false, attached: true, editing: true };
		const reload = vi.fn();
		reloadWhenUnused(appGoneMoment(moment(page)), openGate, reload);
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		page.visible = true;
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		page.attached = false;
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		page.editing = false;
		vi.advanceTimersByTime(500);
		// The typed text alone (saved when the composer unmounted) no longer holds the page.
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("still waits for an open question at a visible return moment", () => {
		vi.useFakeTimers();
		const page = { askOpen: true };
		const reload = vi.fn();
		reloadWhenUnused(appGoneMoment(moment(page)), openGate, reload);
		vi.advanceTimersByTime(5000);
		expect(reload).not.toHaveBeenCalled();
		page.askOpen = false;
		vi.advanceTimersByTime(500);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
