import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesSource, FILES_DEBOUNCE_MS, FILES_MAX_WAIT_MS, FILES_RETRY_MS } from "./files";
import { fakeContext, fakeWatch } from "./test-context";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("files source across a relaunch", () => {
	const listing = (entries: Record<string, string>, complete = true) => ({ entries, complete });

	it("fires once for what was added, changed or removed while OMPdesk was closed, then keeps the new listing", async () => {
		const files = fakeWatch();
		files.control.listing = listing({ "a.txt": "2:1", "c.txt": "1:1", "keep.txt": "1:1" });
		const { context, fired, saved } = fakeContext({
			listing: listing({ "a.txt": "1:1", "b.txt": "1:1", "keep.txt": "1:1" }),
		});
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["a.txt, b.txt, c.txt changed"]);
		expect(saved).toEqual([{ listing: files.control.listing }]);

		// The next launch with that listing and nothing changed: nothing fires.
		const next = fakeContext(saved.at(-1));
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context: next.context });
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(next.fired).toEqual([]);
	});

	it("merges a change seen while it compares into the same one fire", async () => {
		const files = fakeWatch();
		files.control.listing = listing({ "a.txt": "2:1" });
		const { context, fired } = fakeContext({ listing: listing({ "a.txt": "1:1" }) });
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("a.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 3);
		expect(fired).toEqual(["a.txt changed"]);
	});

	it("without a mark takes the listing as its baseline and fires nothing", async () => {
		const files = fakeWatch();
		files.control.listing = listing({ "a.txt": "1:1" });
		const { context, fired, saved } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		expect(saved).toEqual([{ listing: listing({ "a.txt": "1:1" }) }]);
	});

	it("lists again after each burst, the routine's own writes too, so they never fire on the next launch", async () => {
		const files = fakeWatch();
		const { context, fired, saved, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(0);
		state.running = true;
		files.control.listing = listing({ "out.txt": "5:3" });
		files.emit("out.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual([]);
		expect(saved.at(-1)).toEqual({ listing: listing({ "out.txt": "5:3" }) });
	});

	it("past the listing cap compares the files both listings hold, and a different set as something changed", async () => {
		const files = fakeWatch();
		files.control.listing = listing({ "a.txt": "1:1", "z.txt": "1:1" }, false);
		const { context, fired } = fakeContext({ listing: listing({ "a.txt": "1:1", "b.txt": "1:1" }, false) });
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["Something under /p changed"]);
	});
});

describe("files source", () => {
	it("fires once for a burst, two seconds after the last change, listing each path once", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS - 1);
		files.emit("src/b.ts");
		files.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS - 1);
		expect(fired).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toEqual(["src/a.ts, src/b.ts changed"]);

		files.emit("src/c.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["src/a.ts, src/b.ts changed", "src/c.ts changed"]);
	});

	it("fires on a steady stream within ten seconds of its first change", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		for (let elapsed = 0; elapsed < FILES_MAX_WAIT_MS; elapsed += 1_000) {
			files.emit(`f${elapsed}.txt`);
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(fired).toHaveLength(1);
	});

	it("lists at most ten paths and counts the rest, with Windows separators read as slashes", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		for (let index = 0; index < 13; index++) files.emit(`dir\\f${index}.txt`);
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toBe(
			`${Array.from({ length: 10 }, (_, index) => `dir/f${index}.txt`).join(", ")} changed, and 3 more`,
		);
	});

	it("never fires for .git or node_modules", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit(".git/index.lock");
		files.emit("web/node_modules/x/index.js");
		files.emit("sub/.git/HEAD");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		files.emit("src/.gitignore");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["src/.gitignore changed"]);
	});

	it("takes the routine's own writes for nothing: not while its run goes, not just after, and again later", async () => {
		const files = fakeWatch();
		const { context, fired, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		state.running = true;
		files.emit("out.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		state.running = false;
		state.quiet = true;
		files.emit("out2.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);
		state.quiet = false;
		files.emit("real.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["real.txt changed"]);
	});

	it("drops a burst whose run started before it was told", async () => {
		const files = fakeWatch();
		const { context, fired, state } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("a.txt");
		state.running = true;
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual([]);
	});

	it("retries a path that does not exist every minute, fires nothing, and tells the failure once", async () => {
		const files = fakeWatch();
		files.control.missing = true;
		const { context, fired, warned } = fakeContext();
		createFilesSource({ path: "/gone", watch: files.watch, scan: files.scan, context });
		expect(files.control.attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS * 3);
		expect(files.control.attempts).toBe(4);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("ENOENT");
		expect(fired).toEqual([]);

		files.control.missing = false;
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS);
		expect(files.live()).toHaveLength(1);
		files.emit("x.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		expect(fired).toEqual(["x.txt changed"]);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS * 3);
		expect(files.control.attempts).toBe(5);
	});

	it("watches again a minute after its watcher failed, closing the failed one", async () => {
		const files = fakeWatch();
		const { context } = fakeContext();
		createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.fail();
		expect(files.watchers[0]?.closed).toBe(true);
		expect(files.live()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(FILES_RETRY_MS);
		expect(files.live()).toHaveLength(1);
	});

	it("leaves no watcher or timer after stop, and ignores events that come after it", async () => {
		const files = fakeWatch();
		const { context, fired } = fakeContext();
		const source = createFilesSource({ path: "/p", watch: files.watch, scan: files.scan, context });
		files.emit("a.txt");
		source.stop();
		expect(files.live()).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		files.watchers[0]?.onChange("late.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(fired).toEqual([]);

		files.control.missing = true;
		const retrying = createFilesSource({ path: "/gone", watch: files.watch, scan: files.scan, context });
		retrying.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
