import { describe, expect, it, vi } from "vitest";
import {
	purgeAndReload,
	type RegistrationLike,
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

	it("becomes available when a new worker finishes installing, and tells listeners", () => {
		const registration = new FakeRegistration();
		const watcher = new UpdateWatcher(registration, new FakeContainer(), () => {});
		const changed = vi.fn();
		watcher.onChange(changed);
		const worker = new FakeWorker();
		registration.found(worker);
		worker.become("installing");
		expect(watcher.available).toBe(false);
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
	askOpen: () => false,
	uploading: () => false,
	editing: () => false,
};
const moment = (over: Partial<Record<keyof SafeMoment, boolean>>): SafeMoment => ({
	visible: () => over.visible ?? true,
	draftEmpty: () => over.draftEmpty ?? true,
	askOpen: () => over.askOpen ?? false,
	uploading: () => over.uploading ?? false,
	editing: () => over.editing ?? false,
});

describe("safeToReload", () => {
	it("is only a foreground page with an empty draft, no open question and no upload", () => {
		expect(safeToReload(calm)).toBe(true);
		expect(safeToReload(moment({ visible: false }))).toBe(false);
		expect(safeToReload(moment({ draftEmpty: false }))).toBe(false);
		expect(safeToReload(moment({ askOpen: true }))).toBe(false);
		expect(safeToReload(moment({ uploading: true }))).toBe(false);
		expect(safeToReload(moment({ editing: true }))).toBe(false);
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
		).resolves.toBeUndefined();
		expect(reload).toHaveBeenCalledTimes(2);
	});
});
