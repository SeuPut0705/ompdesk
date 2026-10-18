import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { createMessagesStore } from "../stores/messages";
import { resetSnapshotsForTest } from "./snapshot-cache";
import {
	isSeededTranscript,
	readTranscriptSnapshot,
	reuseSeededRows,
	seedTranscript,
	TRANSCRIPT_SNAPSHOT_MESSAGES,
	transcriptKey,
	trimForSnapshot,
	writeTranscriptSnapshot,
} from "./transcript-snapshot";

const user = (n: number, text = `prompt ${n}`): AgentMessage =>
	({ role: "user", content: text, timestamp: n, entryId: `e${n}` }) as AgentMessage;

class Store {
	readonly map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

let storage: Store;
beforeEach(() => {
	storage = new Store();
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	resetSnapshotsForTest();
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, "localStorage");
	resetSnapshotsForTest();
});

describe("transcript snapshot", () => {
	it("keys by the session file, else the session id, else nothing", () => {
		expect(transcriptKey({ sessionPath: "/a.jsonl", sessionId: "x" })).toBe("path:/a.jsonl");
		expect(transcriptKey({ sessionId: "x" })).toBe("id:x");
		expect(transcriptKey({})).toBeNull();
	});

	it("keeps the newest rows within the count and the size, never an unsent echo", () => {
		const many = Array.from({ length: TRANSCRIPT_SNAPSHOT_MESSAGES + 30 }, (_, i) => user(i));
		const kept = trimForSnapshot(many);
		expect(kept).toHaveLength(TRANSCRIPT_SNAPSHOT_MESSAGES);
		expect(kept.at(-1)?.entryId).toBe(`e${many.length - 1}`);
		const big = [user(1, "a".repeat(150_000)), user(2, "b".repeat(150_000)), user(3, "c")];
		expect(trimForSnapshot(big).map(m => m.entryId)).toEqual(["e2", "e3"]);
		expect(trimForSnapshot([user(1), { ...user(2), optimistic: true } as AgentMessage])).toHaveLength(1);
	});

	it("seeds an empty store once, marks it restored and has no cursor", () => {
		const tab = { sessionPath: "/s.jsonl" };
		writeTranscriptSnapshot(tab, [user(1), user(2)]);
		const store = createMessagesStore();
		const rows = seedTranscript(store, tab);
		expect(rows?.map(m => m.entryId)).toEqual(["e1", "e2"]);
		expect(store.getState().restoredAt).not.toBeNull();
		expect(store.getState().prevCursor).toBeUndefined();
		expect(isSeededTranscript(store.getState().messages)).toBe(true);
		// A store that already shows rows is never overwritten.
		expect(seedTranscript(store, tab)).toBeNull();
	});

	it("does not seed another host's session or a session nothing is known of", () => {
		writeTranscriptSnapshot({ sessionPath: "/s.jsonl", device: "dev-1" }, [user(1)]);
		expect(readTranscriptSnapshot({ sessionPath: "/s.jsonl" })).toBeNull();
		expect(readTranscriptSnapshot({ sessionPath: "/s.jsonl", device: "dev-2" })).toBeNull();
		expect(readTranscriptSnapshot({ sessionPath: "/s.jsonl", device: "dev-1" })?.messages).toHaveLength(1);
		expect(seedTranscript(createMessagesStore(), {})).toBeNull();
	});

	it("never stores a credential a message carried", () => {
		writeTranscriptSnapshot({ sessionId: "s" }, [user(1, "export KEY=sk-abcdefghijklmnopqrstuv")]);
		expect([...storage.map.values()].join("")).not.toContain("sk-abcdefghijklmnop");
	});

	it("does not write back what it seeded", () => {
		const tab = { sessionId: "s" };
		writeTranscriptSnapshot(tab, [user(1)]);
		const store = createMessagesStore();
		seedTranscript(store, tab);
		const before = [...storage.map.values()].join();
		writeTranscriptSnapshot(tab, store.getState().messages);
		expect([...storage.map.values()].join()).toBe(before);
	});

	it("reuses the seeded object for a row whose content did not change", () => {
		const tab = { sessionId: "s" };
		writeTranscriptSnapshot(tab, [user(1), user(2)]);
		const store = createMessagesStore();
		seedTranscript(store, tab);
		const seeded = store.getState().messages;
		const live = [user(1), user(2, "edited"), user(3)];
		const merged = reuseSeededRows(live, seeded);
		expect(merged[0]).toBe(seeded[0]);
		expect(merged[1]).toBe(live[1]);
		expect(merged[2]).toBe(live[2]);
	});
});
