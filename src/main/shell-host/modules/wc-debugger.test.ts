/**
 * The debugger's own DevTools session against the real shell: a detach that comes before the session finished opening
 * (Take over right after the agent arrived) closes the late session without taking the shell down.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();

describe.skipIf(!executable)("the page debugger's session", () => {
	let shell: TestShell;
	const WIN = 1;
	const WC = 1;

	beforeAll(async () => {
		shell = await startTestShell(executable as string);
		await shell.client.call("win.create", {
			winId: WIN,
			wcId: WC,
			options: {
				show: false,
				width: 320,
				height: 240,
				webPreferences: { offscreen: true, session: "debugger-race" },
			},
		});
		await shell.client.call("wc.op", { wcId: WC, op: "loadURL", args: { url: "about:blank" } });
	}, 90_000);

	afterAll(async () => {
		if (shell) await shell.close();
	}, 30_000);

	it("survives a detach sent before the session opened, and the page answers after the late session went", async () => {
		const evaluate = () =>
			shell.client.call<{ result: { result: { value: unknown } } }>("wc.cdp.send", {
				wcId: WC,
				method: "Runtime.evaluate",
				params: { expression: "1 + 1", returnByValue: true },
			});
		await Promise.all([
			shell.client.call("wc.cdp.attach", { wcId: WC }),
			shell.client.call("wc.cdp.detach", { wcId: WC }),
		]);
		// The page's DevTools channel answers in order: the second evaluate goes out after the first answered, and so
		// after the shell sent `Target.attachToTarget`, whose answer (the late session's release) comes first.
		await evaluate();
		expect((await evaluate()).result.result.value).toBe(2);
		await expect(
			shell.client.call("wc.cdp.send", {
				wcId: WC,
				method: "Runtime.evaluate",
				params: { expression: "1" },
				debugger: true,
			}),
		).rejects.toThrow(/not attached/);
		// Attached again, the debugger gets a session of its own and answers.
		await shell.client.call("wc.cdp.attach", { wcId: WC });
		const again = await shell.client.call<{ result: { result: { value: unknown } } }>("wc.cdp.send", {
			wcId: WC,
			method: "Runtime.evaluate",
			params: { expression: "3", returnByValue: true },
			debugger: true,
		});
		expect(again.result.result.value).toBe(3);
	}, 60_000);

	it("fails a debugger command still in flight when the debugger detaches, at once", async () => {
		const pending = shell.client.call("wc.cdp.send", {
			wcId: WC,
			method: "Runtime.evaluate",
			params: { expression: "new Promise(() => {})", awaitPromise: true },
			debugger: true,
		});
		const settled = pending.then(
			() => "answered",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await shell.client.call("wc.cdp.detach", { wcId: WC });
		// The test's 30 s bound is half the 60 s a command waits for an answer Chromium never sends for a closed session.
		expect(await settled).toMatch(/target closed while handling command/);
		// The page's own session still answers, and the debugger can attach again.
		const own = await shell.client.call<{ result: { result: { value: unknown } } }>("wc.cdp.send", {
			wcId: WC,
			method: "Runtime.evaluate",
			params: { expression: "4", returnByValue: true },
		});
		expect(own.result.result.value).toBe(4);
		await shell.client.call("wc.cdp.attach", { wcId: WC });
	}, 30_000);
});
