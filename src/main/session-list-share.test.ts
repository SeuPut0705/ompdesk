import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../shared/ipc-types";
import type { SessionListDelta } from "../shared/session-list-delta";
import { SessionListShare } from "./session-list-share";

const row = (path: string, size = 1): SessionInfo => ({
	path,
	id: path,
	title: null,
	cwd: "/work",
	created: "2026-10-01T00:00:00.000Z",
	modified: "2026-10-30T00:00:00.000Z",
	messageCount: 1,
	size,
	status: "complete",
	firstMessage: "hi",
});

/** A share over a list the test changes, whose reads wait until the test lets them answer. */
function rig(initial: SessionInfo[]) {
	let rows = initial;
	const reads: Array<() => void> = [];
	const share = new SessionListShare(async () => {
		// What the read sees is the list as it was when the read began.
		const seen = rows;
		const { promise, resolve } = Promise.withResolvers<void>();
		reads.push(resolve);
		await promise;
		return seen;
	});
	const changes: Array<SessionListDelta | null> = [];
	share.onChange = delta => changes.push(delta);
	const answerAll = async () => {
		while (reads.length > 0) {
			for (const answer of reads.splice(0)) answer();
			await new Promise(resolve => setImmediate(resolve));
		}
	};
	return {
		share,
		reads,
		changes,
		answerAll,
		set: (next: SessionInfo[]) => {
			rows = next;
		},
	};
}

describe("SessionListShare", () => {
	it("answers every ask at once from one read, and from the copy until something changes", async () => {
		const r = rig([row("/a")]);
		const asks = [r.share.current(), r.share.current(), r.share.current()];
		expect(r.reads).toHaveLength(1);
		await r.answerAll();
		const answers = await Promise.all(asks);
		expect(new Set(answers.map(answer => answer.version)).size).toBe(1);
		expect(answers[0]?.sessions).toBe(answers[1]?.sessions);
		await r.share.current();
		expect(r.reads).toHaveLength(0);
	});

	it("reads once a change and hands on only what changed, nothing for a change that moved no row", async () => {
		const r = rig([row("/a"), row("/b")]);
		const first = r.share.current();
		await r.answerAll();
		const v1 = (await first).version;
		r.set([row("/a", 2), row("/c")]);
		r.share.changed();
		r.share.changed();
		await r.answerAll();
		expect(r.changes).toEqual([
			{ base: v1, version: expect.any(String), set: [row("/a", 2), row("/c")], remove: ["/b"] },
		]);
		const v2 = r.changes[0]?.version;
		// A subagent's journal moved: the list read the same, so nobody hears anything and the version stays.
		r.share.changed();
		await r.answerAll();
		expect(r.changes).toHaveLength(1);
		const now = r.share.current();
		await r.answerAll();
		expect((await now).version).toBe(v2);
	});

	it("never answers an ask made after a change with a read that started before it", async () => {
		const r = rig([row("/a")]);
		const first = r.share.current();
		await r.answerAll();
		await first;
		r.share.stale();
		const before = r.share.current();
		r.set([row("/a", 5)]);
		r.share.stale();
		const after = r.share.current();
		// The read under way started before the second change: it answers the earlier ask only.
		for (const answer of r.reads.splice(0)) answer();
		expect((await before).sessions[0]?.size).toBe(1);
		await r.answerAll();
		expect((await after).sessions[0]?.size).toBe(5);
	});

	it("says a change happened, with nothing to compare, while nobody has read the list", async () => {
		const r = rig([row("/a")]);
		r.share.changed();
		expect(r.changes).toEqual([null]);
		expect(r.reads).toHaveLength(0);
	});

	it("takes a list read elsewhere as its copy and hands on what changed", async () => {
		const r = rig([row("/a")]);
		const first = r.share.current();
		await r.answerAll();
		const v1 = (await first).version;
		r.share.set([row("/a"), row("/b")]);
		expect(r.changes).toEqual([{ base: v1, version: expect.any(String), set: [row("/b")], remove: [] }]);
		expect((await r.share.current()).sessions).toHaveLength(2);
		expect(r.reads).toHaveLength(0);
	});

	it("keeps a list stale that a list read elsewhere is applied to, so the next ask still reads", async () => {
		const r = rig([row("/a")]);
		const first = r.share.current();
		await r.answerAll();
		await first;
		r.share.stale();
		r.share.set([row("/a"), row("/b")]);
		const next = r.share.current();
		expect(r.reads).toHaveLength(1);
		await r.answerAll();
		expect((await next).sessions).toHaveLength(1);
	});
});
