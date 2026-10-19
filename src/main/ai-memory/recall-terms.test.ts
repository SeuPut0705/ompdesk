/** The recall term corpus (recall-terms.ts): incremental refresh, rebuild on a moved store, quiet failures. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallTermsIndex } from "./recall-terms";
import type { ConclusionPage } from "./sync";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "recall-terms-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A fake store holding `bodies` per stream; seq = index + 1. */
function fakeStore(streams: { native: string[]; synced: string[] }, state = { store: "db1", fail: false }) {
	const calls: [string, number][] = [];
	return {
		state,
		calls,
		streams,
		store: {
			async conclusions(source: "native" | "synced", after: number, limit: number): Promise<ConclusionPage> {
				if (state.fail) throw new Error("down");
				calls.push([source, after]);
				const all = streams[source];
				const slice = all.slice(after, after + limit);
				return {
					rows: slice.map((body, i) => ({
						seq: after + i + 1,
						workspace: "w",
						project: "p",
						id: `${source}${after + i}`,
						sessionId: "s",
						title: "t",
						body,
						at: "",
					})),
					next: after + slice.length,
					more: after + slice.length < all.length,
					store: state.store,
					last: all.length,
				};
			},
		},
	};
}

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("RecallTermsIndex", () => {
	it("adds only new rows on a later refresh and writes nothing when unchanged", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: ["memory prompt"] });
		const index = new RecallTermsIndex({ store: fake.store, file });
		await index.refresh();
		expect(await read(file)).toMatchObject({
			v: 1,
			store: "db1",
			native: 1,
			synced: 1,
			n: 2,
			df: { memory: 2, server: 1, prompt: 1 },
		});
		const before = (await stat(file)).mtimeMs;
		await new Promise(resolve => setTimeout(resolve, 20));
		await index.refresh();
		expect((await stat(file)).mtimeMs).toBe(before);
		fake.streams.native.push("memory tailscale");
		fake.calls.length = 0;
		await index.refresh();
		expect(fake.calls[0]).toEqual(["native", 1]);
		expect(await read(file)).toMatchObject({ native: 2, n: 3, df: { memory: 3, tailscale: 1 } });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("rebuilds from zero when the store changes or a cursor is past last", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["alpha beta", "alpha gamma"], synced: [] });
		await new RecallTermsIndex({ store: fake.store, file }).refresh();
		fake.state.store = "db2";
		fake.streams.native.splice(0, 2, "delta epsilon");
		await new RecallTermsIndex({ store: fake.store, file }).refresh();
		expect(await read(file)).toMatchObject({ store: "db2", n: 1, df: { delta: 1, epsilon: 1 } });
		fake.streams.native.splice(0, 1, "zeta eta", "zeta theta");
		const index = new RecallTermsIndex({ store: fake.store, file });
		await index.refresh();
		expect(await read(file)).toMatchObject({ native: 2, n: 2 });
		fake.streams.native.length = 0;
		fake.streams.native.push("omega sigma");
		await index.refresh();
		expect(await read(file)).toMatchObject({ n: 1, df: { omega: 1, sigma: 1 } });
	});

	it("logs a failing read and keeps the old file", async () => {
		const file = join(dir, "recall-terms.json");
		const fake = fakeStore({ native: ["memory server"], synced: [] });
		const logs: string[] = [];
		const index = new RecallTermsIndex({ store: fake.store, file, log: message => logs.push(message) });
		await index.refresh();
		const before = await readFile(file, "utf8");
		fake.state.fail = true;
		fake.streams.native.push("more words");
		await expect(index.refresh()).resolves.toBeUndefined();
		expect(logs.length).toBeGreaterThan(0);
		expect(await readFile(file, "utf8")).toBe(before);
	});
});
