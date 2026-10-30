/**
 * A terminal viewport's poll (design §7.2), a desktop window's and a web viewer's: `list` with `waitMs` is held in the
 * stock helper's service until a session has output past the viewer's offset, exits, changes what a viewer shows
 * (size, restart, close, clear, a claim of the size), or the hold ends; `budget` cuts one reply and the offset it
 * returns is where the cut fell, so the viewer's next request (its acknowledgement) reads on from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Pty,
	type PtyOptions,
	TerminalService,
} from "../../../resources/gui-bridge/stock-helper/terminal-service";
import { TERMINAL_OUTPUT_BUDGET, TERMINAL_POLL_MAX_WAIT_MS } from "../../shared/terminal-types";
import { validTerminalOperation } from "./requests";

const options: PtyOptions = { application: "/bin/zsh", args: ["-l"], cwd: "/project", env: {}, cols: 80, rows: 24 };

function fixture() {
	const chunks: Array<(error: Error | null, text: string) => void> = [];
	const exits: Array<(value: { exitCode?: number }) => void> = [];
	const service = new TerminalService(
		() =>
			({
				startArgv: (_options, onChunk) => {
					chunks.push(onChunk);
					const done = Promise.withResolvers<{ exitCode?: number }>();
					exits.push(done.resolve);
					return done.promise;
				},
				write: vi.fn(),
				resize: vi.fn(),
				kill: vi.fn(),
			}) satisfies Pty,
	);
	const [session] = service.request("tab", { action: "create", cols: 80, rows: 24 }, options);
	if (!session) throw new Error("no session");
	return { service, id: session.id, chunk: chunks[0]!, exit: exits[0]! };
}

describe("terminal long poll", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds an idle poll for the wait and then answers with nothing new", async () => {
		const { service, id } = fixture();
		let answered = false;
		const reply = service
			.list("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }, options)
			.then(snapshots => {
				answered = true;
				return snapshots;
			});
		await vi.advanceTimersByTimeAsync(999);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(await reply).toEqual([expect.objectContaining({ id, output: "", offset: 0, cols: 80, rows: 24 })]);
	});

	it("answers the moment the PTY writes, long before the hold ends", async () => {
		const { service, id, chunk } = fixture();
		const reply = service.list("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }, options);
		await vi.advanceTimersByTimeAsync(40);
		chunk(null, "hello\r\n");
		const [snapshot] = await reply;
		expect(snapshot).toMatchObject({ output: "hello\r\n", offset: 7 });
		// No timer is left behind: the hold's own timeout was cleared.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("answers at once when output is already waiting past the offset", async () => {
		const { service, id, chunk } = fixture();
		chunk(null, "abc");
		const [snapshot] = await service.list("tab", { action: "list", offsets: { [id]: 1 }, waitMs: 1000 }, options);
		expect(snapshot).toMatchObject({ output: "bc", offset: 3 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("wakes for an exit, so the viewer learns the shell is gone", async () => {
		const { service, id, exit } = fixture();
		const reply = service.list("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }, options);
		exit({ exitCode: 2 });
		const [snapshot] = await reply;
		expect(snapshot).toMatchObject({ exited: true, exitCode: 2 });
	});

	it("wakes another window's poll when one resizes or claims the PTY, so it follows the new size at once", async () => {
		const { service, id } = fixture();
		const resized = service.list("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }, options);
		service.request("tab", { action: "resize", id, cols: 120, rows: 40 }, options);
		expect(await resized).toEqual([expect.objectContaining({ id, output: "", cols: 120, rows: 40 })]);
		const claimed = service.list("tab", { action: "list", offsets: { [id]: 0 }, waitMs: 1000 }, options);
		// A claim answers as a list (no output) and is no error, even for a session already gone.
		expect(service.request("tab", { action: "claim", id: "gone" }, options)).toEqual([
			expect.objectContaining({ id, output: "" }),
		]);
		await claimed;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cuts a reply to the budget and reports where it cut, so the next poll continues without a gap", async () => {
		const { service, id, chunk } = fixture();
		chunk(null, "0123456789");
		const first = (
			await service.list("tab", { action: "list", offsets: { [id]: 0 }, budget: 4, waitMs: 1000 }, options)
		)[0];
		expect(first).toMatchObject({ output: "0123", offset: 4 });
		const second = (
			await service.list("tab", { action: "list", offsets: { [id]: 4 }, budget: 4, waitMs: 1000 }, options)
		)[0];
		expect(second).toMatchObject({ output: "4567", offset: 8 });
		const last = (
			await service.list("tab", { action: "list", offsets: { [id]: 8 }, budget: 4, waitMs: 1000 }, options)
		)[0];
		expect(last).toMatchObject({ output: "89", offset: 10 });
	});

	it("never ends a reply between the halves of a surrogate pair", async () => {
		const { service, id, chunk } = fixture();
		chunk(null, "ab😀cd");
		const first = (await service.request("tab", { action: "list", offsets: { [id]: 0 }, budget: 3 }, options))[0];
		expect(first).toMatchObject({ output: "ab", offset: 2 });
		const second = (await service.request("tab", { action: "list", offsets: { [id]: 2 }, budget: 3 }, options))[0];
		expect(second).toMatchObject({ output: "😀c", offset: 5 });
	});

	it("a session the viewer has no offset for is no news: the hold runs its length", async () => {
		const { service, chunk } = fixture();
		chunk(null, "x");
		let answered = false;
		void service.list("tab", { action: "list", offsets: {}, waitMs: 1000 }, options).then(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(1001);
		// Nothing was past an offset, so it waited out the hold (a viewer with no offsets is only asking what exists).
		expect(answered).toBe(true);
	});
});

describe("terminal list validation", () => {
	it("accepts a wait up to one second and a budget up to the cap, and refuses more", () => {
		expect(validTerminalOperation({ action: "list", offsets: { a: 0 }, waitMs: TERMINAL_POLL_MAX_WAIT_MS })).toBe(
			true,
		);
		expect(validTerminalOperation({ action: "list", waitMs: TERMINAL_POLL_MAX_WAIT_MS + 1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", waitMs: -1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", budget: TERMINAL_OUTPUT_BUDGET })).toBe(true);
		expect(validTerminalOperation({ action: "list", budget: TERMINAL_OUTPUT_BUDGET + 1 })).toBe(false);
		expect(validTerminalOperation({ action: "list", budget: 0 })).toBe(false);
		expect(validTerminalOperation({ action: "claim", id: "a" })).toBe(true);
		expect(validTerminalOperation({ action: "claim" } as never)).toBe(false);
	});
});
