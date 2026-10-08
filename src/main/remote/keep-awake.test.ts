import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_AWAKE_RELEASE_MS, KeepAwakePolicy } from "./keep-awake";

function setup() {
	let next = 0;
	const blocker = {
		start: vi.fn(() => ++next),
		stop: vi.fn((_id: number) => {}),
	};
	const onChange = vi.fn();
	const policy = new KeepAwakePolicy({ blocker, onChange });
	return { blocker, onChange, policy };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("KeepAwakePolicy", () => {
	it("starts the blocker when a device connects, once", () => {
		const { blocker, policy } = setup();
		policy.update({ enabled: true, connected: false, running: false });
		expect(blocker.start).not.toHaveBeenCalled();

		policy.update({ enabled: true, connected: true, running: false });
		policy.update({ enabled: true, connected: true, running: true });
		expect(blocker.start).toHaveBeenCalledTimes(1);
		expect(policy.held).toBe(true);
	});

	it("stays held while a turn runs after the device disconnects", () => {
		const { blocker, policy } = setup();
		policy.update({ enabled: true, connected: true, running: true });
		policy.update({ enabled: true, connected: false, running: true });
		vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS * 5);
		expect(blocker.stop).not.toHaveBeenCalled();
		expect(policy.held).toBe(true);
	});

	it("releases after the debounce once nothing uses it, and a reconnect within it keeps the same blocker", () => {
		const { blocker, onChange, policy } = setup();
		policy.update({ enabled: true, connected: true, running: false });
		policy.update({ enabled: true, connected: false, running: false });
		vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS - 1);
		policy.update({ enabled: true, connected: true, running: false });
		policy.update({ enabled: true, connected: false, running: false });
		vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS - 1);
		expect(blocker.stop).not.toHaveBeenCalled();
		expect(blocker.start).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("releases immediately when the option is turned off", () => {
		const { blocker, onChange, policy } = setup();
		policy.update({ enabled: true, connected: true, running: true });
		policy.update({ enabled: false, connected: true, running: true });
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
		vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("turning it off during the debounce releases now and cancels the pending release", () => {
		const { blocker, onChange, policy } = setup();
		policy.update({ enabled: true, connected: true, running: false });
		policy.update({ enabled: true, connected: false, running: false });
		policy.update({ enabled: false, connected: false, running: false });
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("re-acquires when turned back on while a device is connected", () => {
		const { blocker, policy } = setup();
		policy.update({ enabled: true, connected: true, running: false });
		policy.update({ enabled: false, connected: true, running: false });
		expect(policy.held).toBe(false);

		policy.update({ enabled: true, connected: true, running: false });
		expect(blocker.start).toHaveBeenCalledTimes(2);
		expect(policy.held).toBe(true);
	});

	it("dispose releases a held blocker", () => {
		const { blocker, policy } = setup();
		policy.update({ enabled: true, connected: false, running: true });
		policy.dispose();
		expect(blocker.stop).toHaveBeenCalledWith(1);
		expect(policy.held).toBe(false);
	});
});
