import { describe, expect, it } from "vitest";
import {
	createDeferredWriter,
	createSnapshotCache,
	ENTRY_MAX_CHARS,
	KIND_LIMITS,
	SNAPSHOT_MAX_AGE_MS,
	SNAPSHOT_VERSION,
	type SnapshotStorage,
	scrub,
	snapshotNs,
	TOTAL_MAX_CHARS,
} from "./snapshot-cache";

class MemoryStorage implements SnapshotStorage {
	readonly map = new Map<string, string>();
	quota = Number.POSITIVE_INFINITY;
	get length() {
		return this.map.size;
	}
	key(index: number) {
		return [...this.map.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		const used = [...this.map.entries()].reduce((n, [k, v]) => (k === key ? n : n + v.length), 0);
		if (used + value.length > this.quota) throw new DOMException("full", "QuotaExceededError");
		this.map.set(key, value);
	}
	removeItem(key: string) {
		this.map.delete(key);
	}
}

function make(start = 1_000_000) {
	const storage = new MemoryStorage();
	const clock = { t: start };
	const cache = createSnapshotCache({ storage, now: () => clock.t });
	return { storage, clock, cache };
}

describe("snapshot cache", () => {
	it("round-trips a value with its write time", () => {
		const { cache, clock } = make();
		expect(cache.write("tabs", "local", "main", { ids: ["a", "b"] })).toBe(true);
		clock.t += 5;
		expect(cache.read("tabs", "local", "main")).toEqual({ value: { ids: ["a", "b"] }, at: 1_000_000 });
		expect(cache.read("tabs", "local", "other")).toBeNull();
	});

	it("never reads another version's entry and prunes it", () => {
		const { cache, storage } = make();
		storage.setItem("omp.snap.0.tabs.local.main", JSON.stringify({ v: 0, at: 1_000_000, d: 1 }));
		storage.setItem("unrelated", "x");
		cache.pruneStale();
		expect(storage.getItem("omp.snap.0.tabs.local.main")).toBeNull();
		expect(storage.getItem("unrelated")).toBe("x");
		storage.setItem(
			`omp.snap.${SNAPSHOT_VERSION}.tabs.local.main`,
			JSON.stringify({ v: SNAPSHOT_VERSION + 1, at: 1_000_000, d: 1 }),
		);
		expect(cache.read("tabs", "local", "main")).toBeNull();
	});

	it("drops an entry past the max age or stamped in the future, and a corrupt one", () => {
		const { cache, clock, storage } = make();
		cache.write("usage", "local", "u", [1]);
		clock.t += SNAPSHOT_MAX_AGE_MS + 1;
		expect(cache.read("usage", "local", "u")).toBeNull();
		expect(cache.totalChars()).toBe(0);
		storage.setItem(`omp.snap.${SNAPSHOT_VERSION}.usage.local.bad`, "{nope");
		expect(cache.read("usage", "local", "bad")).toBeNull();
		expect(storage.getItem(`omp.snap.${SNAPSHOT_VERSION}.usage.local.bad`)).toBeNull();
	});

	it("keeps each namespace apart and forgets one on demand", () => {
		const { cache } = make();
		cache.write("transcript", snapshotNs(), "s1", "mine");
		cache.write("transcript", snapshotNs("dev-1"), "s1", "host one");
		cache.write("transcript", snapshotNs("dev-2"), "s1", "host two");
		expect(cache.read<string>("transcript", "local", "s1")?.value).toBe("mine");
		expect(cache.read<string>("transcript", "device:dev-1", "s1")?.value).toBe("host one");
		cache.clearNamespace("device:dev-1");
		expect(cache.read("transcript", "device:dev-1", "s1")).toBeNull();
		expect(cache.read<string>("transcript", "device:dev-2", "s1")?.value).toBe("host two");
		expect(cache.read<string>("transcript", "local", "s1")?.value).toBe("mine");
		cache.clearAll();
		expect(cache.totalChars()).toBe(0);
	});

	it("keeps only the newest entries of a kind", () => {
		const { cache, clock } = make();
		const limit = KIND_LIMITS.transcript;
		for (let i = 0; i < limit + 3; i++) {
			clock.t += 10;
			cache.write("transcript", "local", `s${i}`, i);
		}
		expect(cache.read("transcript", "local", "s0")).toBeNull();
		expect(cache.read("transcript", "local", "s2")).toBeNull();
		expect(cache.read<number>("transcript", "local", `s${limit + 2}`)?.value).toBe(limit + 2);
		expect(cache.read<number>("transcript", "local", "s3")?.value).toBe(3);
	});

	it("refuses an oversized entry and keeps the whole cache under its budget", () => {
		const { cache, clock } = make();
		expect(cache.write("transcript", "local", "huge", "x".repeat(ENTRY_MAX_CHARS + 1))).toBe(false);
		const piece = "y".repeat(ENTRY_MAX_CHARS - 100);
		for (const kind of ["transcript", "sessions", "tabs", "usage", "models", "shell"] as const)
			for (let i = 0; i < 3; i++) {
				clock.t += 1;
				cache.write(kind, "local", `k${i}`, piece);
			}
		expect(cache.totalChars()).toBeLessThanOrEqual(TOTAL_MAX_CHARS);
		expect(cache.read("shell", "local", "k2")).not.toBeNull();
	});

	it("evicts the oldest entry and retries when the storage is full", () => {
		const { cache, clock, storage } = make();
		cache.write("sessions", "local", "old", "a".repeat(1000));
		clock.t += 10;
		storage.quota = 2200;
		expect(cache.write("sessions", "local", "new", "b".repeat(1500))).toBe(true);
		expect(cache.read("sessions", "local", "old")).toBeNull();
		expect(cache.read("sessions", "local", "new")).not.toBeNull();
	});

	it("rebuilds a lost index from the entries", () => {
		const { cache, storage, clock } = make();
		cache.write("models", "local", "m", [1]);
		storage.removeItem(`omp.snap.${SNAPSHOT_VERSION}.index`);
		const again = createSnapshotCache({ storage, now: () => clock.t });
		expect(again.totalChars()).toBeGreaterThan(0);
		again.clearAll();
		expect(again.read("models", "local", "m")).toBeNull();
	});

	it("has no storage: reads miss and writes are refused", () => {
		const cache = createSnapshotCache({ storage: null });
		expect(cache.write("tabs", "local", "m", 1)).toBe(false);
		expect(cache.read("tabs", "local", "m")).toBeNull();
	});
});

describe("snapshot privacy", () => {
	it("drops credential keys, token-shaped strings and picture bytes", () => {
		const input = {
			title: "deploy",
			apiKey: "sk-live-abcdefghijklmnop1234",
			nested: { Authorization: "Bearer abc", cookie: "a=b", ok: 1 },
			text: "use sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuv then Bearer abcdefghijklmnopqrstuvwxyz",
			jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			pem: "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
			content: [{ type: "image", mimeType: "image/png", data: "AAAA".repeat(100) }],
			list: [{ password: "p", name: "n" }],
		};
		const out = scrub(input);
		const text = JSON.stringify(out);
		expect(text).not.toMatch(/sk-|ghp_|Bearer abc|eyJhb|PRIVATE KEY|AAAA|"cookie"|"password"|apiKey/);
		expect(out.title).toBe("deploy");
		expect(out.nested).toEqual({ ok: 1 });
		expect(out.list).toEqual([{ name: "n" }]);
		expect(out.content[0]).toEqual({ type: "image", mimeType: "image/png" });
		// The input is untouched.
		expect(input.apiKey).toContain("sk-live");
	});

	it("scrubs on write, so a stored value never carries a secret", () => {
		const { cache, storage } = make();
		cache.write("transcript", "local", "s", { token: "t", text: "key sk-abcdefghijklmnopqrstuv" });
		const raw = [...storage.map.values()].join("\n");
		expect(raw).not.toContain("sk-abc");
		expect(raw).not.toContain('"token"');
	});
});

describe("deferred writer", () => {
	it("coalesces repeated writes of one key into one produced value", () => {
		const { cache } = make();
		const queue: Array<() => void> = [];
		const write = createDeferredWriter(
			() => cache,
			run => {
				queue.push(run);
				return () => {};
			},
		);
		let latest = 0;
		for (let i = 1; i <= 5; i++) {
			latest = i;
			write("tabs", "local", "main", () => latest);
		}
		expect(queue).toHaveLength(1);
		queue[0]();
		expect(cache.read<number>("tabs", "local", "main")?.value).toBe(5);
		write("tabs", "local", "main", () => 6);
		expect(queue).toHaveLength(2);
	});
});
