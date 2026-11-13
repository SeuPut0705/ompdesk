/**
 * The real-shell harness itself (PROTOCOL.md §15.3 step 1), so CI's `shell-parity` job proves it before any slice's
 * suite relies on it: the handshake reaches `app.ready`, a name no module owns is refused, and `close` ends the shell.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostError } from "../client";
import { shellModule } from "./client";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();

describe.skipIf(!executable)("the real-shell test harness", () => {
	let shell: TestShell;
	let closed = false;

	beforeAll(async () => {
		shell = await startTestShell(executable as string);
	}, 90_000);

	afterAll(async () => {
		if (shell && !closed) await shell.close();
	}, 30_000);

	it("hands over the facts of its private profile", () => {
		expect(shell.facts.paths.userData).toMatch(/profile$/);
		expect(shell.facts.versions.cef).not.toBe("");
	});

	it("refuses a request in a namespace no module owns", async () => {
		const nobody = shellModule<{
			calls: { ping: { params: Record<string, never>; result: unknown } };
			posts: Record<string, never>;
			events: Record<string, never>;
			asks: Record<string, never>;
		}>("nobodysnamespace", () => shell.client);
		const refused = await nobody.call("ping", {}).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(HostError);
		expect((refused as HostError).code).toBe("unsupported");
	});

	it("still answers after an event in a namespace no module owns", async () => {
		await shell.client.event("nobodysnamespace.ping", {});
		const screen = await shell.client.call<{ x: number; y: number }>("screen.cursorPoint", {});
		expect(typeof screen.x).toBe("number");
	});

	it("exits once Node sent app.exit", async () => {
		const exited = Promise.withResolvers<number | null>();
		shell.process.once("exit", code => exited.resolve(code));
		closed = true;
		await shell.close();
		expect(await exited.promise).toBe(0);
	}, 30_000);
});
