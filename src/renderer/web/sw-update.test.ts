import { describe, expect, it, vi } from "vitest";
import {
	purgeAndReload,
	type RegistrationLike,
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
