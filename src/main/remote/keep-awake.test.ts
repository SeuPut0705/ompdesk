import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceCoreTimersSync, fakeCoreTimers, realCoreTimers } from "../core/test-clock";
import { KEEP_AWAKE_RELEASE_MS, KeepAwakePolicy } from "./keep-awake";

/** The policies a case made: each is disposed after it, so none leaves a timer in the core. */
const made: KeepAwakePolicy[] = [];

function setup() {
	let next = 0;
	const blocker = {
		start: vi.fn(() => ++next),
		stop: vi.fn((_id: number) => {}),
	};
	const onChange = vi.fn();
	const policy = new KeepAwakePolicy({ blocker, onChange });
	made.push(policy);
	return { blocker, onChange, policy };
}

beforeEach(async () => {
	await fakeCoreTimers();
});

afterEach(async () => {
	for (const policy of made.splice(0)) policy.dispose();
	await realCoreTimers();
});

describe("KeepAwakePolicy", () => {
	it("starts the blocker when a device connects, once", async () => {
		const { blocker, policy } = setup();
		await policy.update({ enabled: true, connected: false, running: false });
		expect(blocker.start).not.toHaveBeenCalled();

		await policy.update({ enabled: true, connected: true, running: false });
		await policy.update({ enabled: true, connected: true, running: true });
		expect(blocker.start).toHaveBeenCalledTimes(1);
		expect(policy.held).toBe(true);
	});

	it("stays held while a turn runs after the device disconnects", async () => {
		const { blocker, policy } = setup();
		await policy.update({ enabled: true, connected: true, running: true });
		await policy.update({ enabled: true, connected: false, running: true });
		await advanceCoreTimersSync(KEEP_AWAKE_RELEASE_MS * 5);
		expect(blocker.stop).not.toHaveBeenCalled();
		expect(policy.held).toBe(true);
	});

	it("releases after the debounce once nothing uses it, and a reconnect within it keeps the same blocker", async () => {
		const { blocker, onChange, policy } = setup();
		await policy.update({ enabled: true, connected: true, running: false });
		await policy.update({ enabled: true, connected: false, running: false });
		await advanceCoreTimersSync(KEEP_AWAKE_RELEASE_MS - 1);
		await policy.update({ enabled: true, connected: true, running: false });
		await policy.update({ enabled: true, connected: false, running: false });
		await advanceCoreTimersSync(KEEP_AWAKE_RELEASE_MS - 1);
		expect(blocker.stop).not.toHaveBeenCalled();
		expect(blocker.start).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();

		await advanceCoreTimersSync(1);
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("releases immediately when the option is turned off", async () => {
		const { blocker, onChange, policy } = setup();
		await policy.update({ enabled: true, connected: true, running: true });
		await policy.update({ enabled: false, connected: true, running: true });
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
		await advanceCoreTimersSync(KEEP_AWAKE_RELEASE_MS);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("turning it off during the debounce releases now and cancels the pending release", async () => {
		const { blocker, onChange, policy } = setup();
		await policy.update({ enabled: true, connected: true, running: false });
		await policy.update({ enabled: true, connected: false, running: false });
		await policy.update({ enabled: false, connected: false, running: false });
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		await advanceCoreTimersSync(KEEP_AWAKE_RELEASE_MS);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("re-acquires when turned back on while a device is connected", async () => {
		const { blocker, policy } = setup();
		await policy.update({ enabled: true, connected: true, running: false });
		await policy.update({ enabled: false, connected: true, running: false });
		expect(policy.held).toBe(false);

		await policy.update({ enabled: true, connected: true, running: false });
		expect(blocker.start).toHaveBeenCalledTimes(2);
		expect(policy.held).toBe(true);
	});

	it("dispose releases a held blocker", async () => {
		const { blocker, policy } = setup();
		await policy.update({ enabled: true, connected: false, running: true });
		policy.dispose();
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
	});
});
