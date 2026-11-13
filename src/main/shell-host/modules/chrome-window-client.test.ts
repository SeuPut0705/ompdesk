/**
 * The window client over a fake host: what main gets when the shell refuses an open because a quit is approved (the
 * shell's side runs against the real shell in chrome-window.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { HostError } from "../client";
import type { HostClient } from "../electron/host";
import { pointChromeAt } from "./chrome";
import { WindowManager } from "./chrome-window";

function hostAnswering(answer: () => unknown): { host: HostClient; calls: string[] } {
	const calls: string[] = [];
	const host = {
		call: async (method: string) => {
			calls.push(method);
			return answer();
		},
		request: async () => ({ result: {}, bin: null }),
		event: async () => {},
		handle: () => {},
		on: () => () => {},
		flush: async () => {},
	} as unknown as HostClient;
	return { host, calls };
}

afterEach(() => pointChromeAt());

describe("WindowManager.createWindow", () => {
	it("is null when the shell refused the open because a quit is approved", async () => {
		const { host, calls } = hostAnswering(() => {
			throw new HostError("quitting", "the app is quitting: no window is opened");
		});
		pointChromeAt(() => host);
		const manager = new WindowManager();
		await expect(manager.createWindow({ cwd: "/work" })).resolves.toBeNull();
		expect(calls).toEqual(["chrome.open"]);
		expect(manager.getAllWindows()).toEqual([]);
	});

	it("throws any other failure", async () => {
		const { host } = hostAnswering(() => {
			throw new HostError("failed", "CEF could not create the page");
		});
		pointChromeAt(() => host);
		await expect(new WindowManager().createWindow({ cwd: "/work" })).rejects.toThrow("CEF could not create the page");
	});
});
