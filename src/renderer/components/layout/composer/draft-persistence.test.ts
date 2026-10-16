import { describe, expect, it } from "vitest";
import { draftKeys, loadDraft, saveDraft } from "./draft-persistence";

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: key => items.get(key) ?? null,
		key: index => [...items.keys()][index] ?? null,
		removeItem: key => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, value);
		},
	};
}

describe("composer draft persistence", () => {
	it("keeps a session's draft for its next load and drops it once sent", () => {
		const storage = memoryStorage();
		const keys = draftKeys({ sessionFile: "/s/a.jsonl", sessionId: "a", cwd: "/p", empty: false });
		if (!keys) throw new Error("keys");
		saveDraft(storage, keys, "half a thought", 10);
		expect(loadDraft(storage, keys, 20)).toBe("half a thought");
		saveDraft(storage, keys, "", 30);
		expect(loadDraft(storage, keys, 40)).toBeUndefined();
	});

	it("files drafts per device and has no key before the session is known", () => {
		const storage = memoryStorage();
		expect(draftKeys({ cwd: "/p", empty: true })).toBeUndefined();
		const local = draftKeys({ sessionFile: "/s/a.jsonl", empty: false });
		const remote = draftKeys({ device: "studio", sessionFile: "/s/a.jsonl", empty: false });
		if (!local || !remote) throw new Error("keys");
		saveDraft(storage, local, "here", 1);
		expect(loadDraft(storage, remote, 2)).toBeUndefined();
	});

	it("hands an empty session's draft to the next empty session in that folder after a relaunch, once", () => {
		const storage = memoryStorage();
		const before = draftKeys({ sessionFile: "/s/old.jsonl", cwd: "/p", empty: true });
		const after = draftKeys({ sessionFile: "/s/new.jsonl", cwd: "/p", empty: true });
		const another = draftKeys({ sessionFile: "/s/other.jsonl", cwd: "/p", empty: true });
		if (!before || !after || !another) throw new Error("keys");
		saveDraft(storage, before, "typed before quitting", 100);
		// A tab opened in this page life never copies a draft another open tab is typing.
		expect(loadDraft(storage, another, 50)).toBeUndefined();
		// After the relaunch (the page started later), the new empty session takes it, and only it.
		expect(loadDraft(storage, after, 200, 210)).toBe("typed before quitting");
		expect(loadDraft(storage, another, 200, 220)).toBeUndefined();
		expect(loadDraft(storage, after, 300)).toBe("typed before quitting");
	});

	it("never brings back a folder draft its session already sent", () => {
		const storage = memoryStorage();
		const typing = draftKeys({ sessionFile: "/s/a.jsonl", cwd: "/p", empty: true });
		const sent = draftKeys({ sessionFile: "/s/a.jsonl", cwd: "/p", empty: false });
		const fresh = draftKeys({ sessionFile: "/s/b.jsonl", cwd: "/p", empty: true });
		if (!typing || !sent || !fresh) throw new Error("keys");
		saveDraft(storage, typing, "first prompt", 10);
		saveDraft(storage, sent, "", 20);
		expect(loadDraft(storage, fresh, 100)).toBeUndefined();
	});

	it("survives unreadable storage", () => {
		const storage = memoryStorage();
		storage.setItem("omp.composerDrafts", "{not json");
		const keys = draftKeys({ sessionId: "a", empty: false });
		if (!keys) throw new Error("keys");
		expect(loadDraft(storage, keys, 1)).toBeUndefined();
		saveDraft(storage, keys, "fresh", 2);
		expect(loadDraft(storage, keys, 3)).toBe("fresh");
	});
});
