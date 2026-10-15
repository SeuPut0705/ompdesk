import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { OmpUpdatedNotice, OmpUpdateState } from "../shared/omp-update";
import { compareVersions } from "./omp-runtime";
import {
	CHECK_INTERVAL_MS,
	MAX_CHECK_INTERVAL_MS,
	nextCheckDelay,
	OmpUpdater,
	type OmpUpdaterDeps,
	registerOmpUpdateIpc,
} from "./omp-updater";
import type { OmpUpdateOutcome } from "./setup/service";

const HOUR = 60 * 60 * 1000;

describe("version order", () => {
	it("compares versions numerically, so 18.11 is newer than 18.9", () => {
		expect(compareVersions("18.11.0", "18.9.0")).toBeGreaterThan(0);
		expect(compareVersions("18.9.0", "18.11.0")).toBeLessThan(0);
		expect(compareVersions("18.11.0", "18.11.0")).toBe(0);
		expect(compareVersions("19.0.0", "18.99.99")).toBeGreaterThan(0);
	});
});

describe("nextCheckDelay", () => {
	it("is a few hours while all is well, doubles per failure in a row, and stops at a day", () => {
		expect(nextCheckDelay(0)).toBe(CHECK_INTERVAL_MS);
		expect(CHECK_INTERVAL_MS).toBe(4 * HOUR);
		expect(nextCheckDelay(1)).toBe(8 * HOUR);
		expect(nextCheckDelay(2)).toBe(16 * HOUR);
		expect(nextCheckDelay(3)).toBe(MAX_CHECK_INTERVAL_MS);
		expect(nextCheckDelay(50)).toBe(MAX_CHECK_INTERVAL_MS);
	});
});

interface Harness {
	updater: OmpUpdater;
	calls: string[];
	states: OmpUpdateState[];
	notices: OmpUpdatedNotice[];
	fetchLatest: Mock<() => Promise<string>>;
	update: Mock<OmpUpdaterDeps["update"]>;
	set: { latest: string; installed: string | null; enabled: boolean; outcome: OmpUpdateOutcome };
}

/** An updater over fakes; every dependency call is logged in order in `calls`. */
function harness(options: { scheduled?: boolean; enabled?: boolean; installed?: string | null } = {}): Harness {
	const calls: string[] = [];
	const set: Harness["set"] = {
		latest: "18.9.0",
		installed: options.installed === undefined ? "18.8.7" : options.installed,
		enabled: options.enabled ?? true,
		outcome: { kind: "updated", version: "18.9.0" },
	};
	const states: OmpUpdateState[] = [];
	const notices: OmpUpdatedNotice[] = [];
	const fetchLatest = vi.fn(async () => {
		calls.push("fetch");
		return set.latest;
	});
	const update = vi.fn<OmpUpdaterDeps["update"]>(async (target, beforeInstall) => {
		calls.push(`update ${target}`);
		await beforeInstall();
		if (set.outcome.kind === "updated") set.installed = set.outcome.version;
		return set.outcome;
	});
	const updater = new OmpUpdater({
		scheduled: options.scheduled ?? true,
		enabled: () => set.enabled,
		fetchLatest,
		installed: () => set.installed,
		update,
		releaseHelpers: async () => {
			calls.push("release");
		},
		resume: async updated => {
			calls.push(`resume ${updated}`);
		},
		onState: state => states.push(state),
		onUpdated: notice => {
			calls.push(`toast ${notice.version}`);
			notices.push(notice);
		},
		now: () => Date.now(),
	});
	return { updater, calls, states, notices, fetchLatest, update, set };
}

describe("OmpUpdater", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("checks at launch, installs a newer omp without a click, then checks again every few hours", async () => {
		const h = harness();
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		// Helpers stop right before the installer starts (inside update), come back after it, then the one toast.
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release", "resume true", "toast 18.9.0"]);
		expect(h.updater.state()).toMatchObject({
			phase: "idle",
			installed: "18.9.0",
			latest: "18.9.0",
			updatedTo: "18.9.0",
			failure: null,
		});
		expect(h.states.map(state => state.phase)).toContain("updating");
		h.calls.length = 0;
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(h.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		// Up to date: it only asks the registry.
		expect(h.calls).toEqual(["fetch"]);
		expect(h.update).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("installs nothing when the registry's latest is not newer than the installed omp", async () => {
		const h = harness({ installed: "18.11.0" });
		h.set.latest = "18.9.0";
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch"]);
		expect(h.updater.state()).toMatchObject({ latest: "18.9.0", installed: "18.11.0", failure: null });
		h.updater.dispose();
	});

	it("leaves a missing omp to machine setup: no check (stock's needs an omp to run), no failure", async () => {
		const h = harness({ installed: null });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual([]);
		expect(h.updater.state()).toMatchObject({ phase: "idle", failure: null, latest: null });
		h.updater.dispose();
	});

	it("keeps the registry error as the reason, backs off 4 h → 8 h → 16 h → 24 h, and resets after a good check", async () => {
		const h = harness({ installed: "18.9.0" });
		h.fetchLatest.mockRejectedValue(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.updater.state().failure).toEqual({
			reason: "check",
			detail: "getaddrinfo ENOTFOUND registry.npmjs.org",
		});
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(8 * HOUR - 1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.fetchLatest).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(16 * HOUR);
		expect(h.fetchLatest).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(4);
		// The network is back: the failure clears and the next check is a normal interval away.
		h.fetchLatest.mockImplementation(async () => "18.9.0");
		await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(5);
		expect(h.updater.state().failure).toBeNull();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchLatest).toHaveBeenCalledTimes(6);
		h.updater.dispose();
	});

	it("keeps a failed install's reason in the state, brings the helpers back on the old omp and retries on the next check", async () => {
		const h = harness();
		h.set.outcome = { kind: "failed", failure: { reason: "install", detail: "exit 1 — EBUSY" } };
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release", "resume false"]);
		expect(h.notices).toEqual([]);
		expect(h.updater.state()).toMatchObject({
			phase: "idle",
			installed: "18.8.7",
			updatedTo: null,
			failure: { reason: "install", detail: "exit 1 — EBUSY" },
		});
		// The reason stays until a later attempt succeeds.
		h.calls.length = 0;
		h.set.outcome = { kind: "updated", version: "18.9.0" };
		await vi.advanceTimersByTimeAsync(8 * HOUR);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release", "resume true", "toast 18.9.0"]);
		expect(h.updater.state().failure).toBeNull();
		h.updater.dispose();
	});

	it("skipped (omp went missing meanwhile) leaves no failure and no toast; helpers stay if never released", async () => {
		const h = harness();
		h.set.outcome = { kind: "skipped" };
		h.update.mockImplementation(async target => {
			h.calls.push(`update ${target}`);
			return { kind: "skipped" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0"]);
		expect(h.updater.state().failure).toBeNull();
		h.updater.dispose();
	});

	it("does nothing on a timer while the pref is off, but Update now still checks and installs", async () => {
		const h = harness({ enabled: false });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
		expect(h.calls).toEqual([]);
		expect(h.updater.state().enabled).toBe(false);
		await h.updater.updateNow();
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release", "resume true", "toast 18.9.0"]);
		h.updater.dispose();
	});

	it("turning the pref on checks right away; turning it off stops the timer's checks", async () => {
		const h = harness({ enabled: false, installed: "18.9.0" });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).not.toHaveBeenCalled();
		h.set.enabled = true;
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.set.enabled = false;
		h.updater.prefChanged();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("never checks on its own in a launch that does not schedule (dev, tests); Update now still works", async () => {
		const h = harness({ scheduled: false });
		h.updater.start();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
		expect(h.calls).toEqual([]);
		expect(h.updater.state().scheduled).toBe(false);
		await h.updater.updateNow();
		expect(h.update).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("one run at a time: Update now during a check joins it", async () => {
		const h = harness({ installed: "18.9.0" });
		const gate = Promise.withResolvers<string>();
		h.fetchLatest.mockImplementationOnce(() => gate.promise);
		h.updater.start();
		const joined = h.updater.updateNow();
		gate.resolve("18.9.0");
		await joined;
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchLatest).toHaveBeenCalledTimes(1);
		h.updater.dispose();
	});

	it("never runs after dispose", async () => {
		const h = harness();
		h.updater.dispose();
		h.updater.start();
		await h.updater.updateNow();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toEqual([]);
	});

	it("starts nothing after a quit that lands during an install: no resume, no toast, helpers stay down", async () => {
		const h = harness();
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		h.update.mockImplementation(async (target, beforeInstall) => {
			h.calls.push(`update ${target}`);
			await beforeInstall();
			await gate;
			return { kind: "updated", version: "18.9.0" };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release"]);

		// Quit: the setup service is cancelled and the install returns while the app tears down.
		h.updater.dispose();
		release();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "release"]);
		expect(h.notices).toEqual([]);
	});

	it("does not resume the helpers after a failed install that lands once disposed", async () => {
		const h = harness();
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		h.update.mockImplementation(async (target, beforeInstall) => {
			h.calls.push(`update ${target}`);
			await beforeInstall();
			await gate;
			return { kind: "failed", failure: { reason: "cancelled" } };
		});
		h.updater.start();
		await vi.advanceTimersByTimeAsync(0);
		h.updater.dispose();
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).not.toContain("resume false");
	});

	it("keeps checking after a throw in the update notice (a window that was destroyed meanwhile)", async () => {
		const h = harness();
		let throws = true;
		const updater = new OmpUpdater({
			scheduled: true,
			enabled: () => true,
			fetchLatest: async () => {
				h.calls.push("fetch");
				return h.set.latest;
			},
			installed: () => h.set.installed,
			update: async target => {
				h.calls.push(`update ${target}`);
				h.set.installed = target;
				return { kind: "updated", version: target };
			},
			releaseHelpers: async () => {},
			resume: async () => {},
			onState: () => {},
			onUpdated: () => {
				if (throws) throw new Error("Object has been destroyed");
			},
		});
		updater.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.calls).toEqual(["fetch", "update 18.9.0"]);

		throws = false;
		h.set.latest = "19.0.0";
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.calls).toEqual(["fetch", "update 18.9.0", "fetch", "update 19.0.0"]);
		updater.dispose();
	});
});

describe("omp update IPC", () => {
	it("serves exactly the state snapshot and Update now; nothing crosses that names a version, command or path", () => {
		const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {};
		const updater = { state: vi.fn(() => ({ phase: "idle" }) as OmpUpdateState), updateNow: vi.fn(async () => {}) };
		registerOmpUpdateIpc({ handle: (channel, listener) => (handlers[channel] = listener) }, updater);
		expect(Object.keys(handlers).sort()).toEqual(
			[IPC_COMMANDS.OMP_UPDATE_GET_STATE, IPC_COMMANDS.OMP_UPDATE_NOW].sort(),
		);
		expect(handlers[IPC_COMMANDS.OMP_UPDATE_GET_STATE]?.({})).toEqual({ phase: "idle" });
		// The arguments a renderer might add are ignored.
		handlers[IPC_COMMANDS.OMP_UPDATE_NOW]?.({}, "19.0.0; rm -rf /");
		expect(updater.updateNow).toHaveBeenCalledWith();
	});
});
