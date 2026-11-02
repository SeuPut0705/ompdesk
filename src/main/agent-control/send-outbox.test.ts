import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverOwed, type OutboxSend, type OwedDeps, redeliverSends, SendOutbox } from "./send-outbox";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileIn(): string {
	const dir = mkdtempSync(join(tmpdir(), "send-outbox-"));
	dirs.push(dir);
	return join(dir, "send-outbox.json");
}

function sent(n: number, over: Partial<OutboxSend> = {}): OutboxSend {
	return {
		mark: `[ompdesk dispatch d${n}:`,
		dispatch: n,
		sessionPath: "/s/kid.jsonl",
		from: "/s/boss.jsonl",
		body: `do part ${n}`,
		message: `do part ${n}\n\n[ompdesk dispatch d${n}: report]`,
		streamingBehavior: "followUp",
		at: 1_000,
		...over,
	};
}

/** A receiver omp as stock runs it: a prompt it is handed waits in its queue until the test journals it. */
function omp(instance: string, journal: string[] = []) {
	const prompts: string[] = [];
	const deps: OwedDeps = {
		tabOf: () => "kid00009",
		sent: async (_tabId, marks) => ({ instance, journaled: marks.filter(mark => journal.includes(mark)) }),
		prompt: async (_tabId, entry) => {
			prompts.push(entry.mark);
			return "handed";
		},
		drained: async () => false,
	};
	return { deps, prompts, journal };
}

describe("SendOutbox", () => {
	it("hands a message an ended omp queued to the omp that holds the session after a relaunch, exactly once", async () => {
		const file = fileIn();
		const before = new SendOutbox(file, () => 2_000);
		before.keep(sent(2));
		before.handed(sent(2), "omp-a");

		// Relaunch: the outbox is read back; the child's session is held by a new omp that never saw d2.
		const outbox = new SendOutbox(file, () => 2_000);
		const next = omp("omp-b");
		await redeliverSends(outbox, next.deps);
		expect(next.prompts).toEqual(["[ompdesk dispatch d2:"]);
		// That omp queues it now: asked again, never handed a second time.
		await redeliverSends(outbox, next.deps);
		expect(next.prompts).toHaveLength(1);
		// Its turn took it: the journal holds it, and it is owed no more.
		next.journal.push("[ompdesk dispatch d2:");
		await redeliverSends(outbox, next.deps);
		expect(new SendOutbox(file, () => 2_000).pending()).toEqual([]);
		expect(next.prompts).toHaveLength(1);
	});

	it("never hands a message again to the omp it was handed to, and settles one its journal already holds", async () => {
		const outbox = new SendOutbox(null, () => 2_000);
		outbox.keep(sent(1));
		outbox.handed(sent(1), "omp-a");
		outbox.keep(sent(2));
		outbox.handed(sent(2), "omp-a");
		const same = omp("omp-a", ["[ompdesk dispatch d1:"]);
		await redeliverSends(outbox, same.deps);
		expect(same.prompts).toEqual([]);
		expect(outbox.pending().map(entry => entry.dispatch)).toEqual([2]);
	});

	it("lets go of a message its omp no longer holds while idle with nothing queued (the queue was withdrawn)", async () => {
		const outbox = new SendOutbox(null, () => 2_000);
		outbox.keep(sent(2));
		outbox.handed(sent(2), "omp-a");
		const withdrawn = omp("omp-a");
		withdrawn.deps.drained = async () => true;
		await redeliverSends(outbox, withdrawn.deps);
		expect(outbox.pending()).toEqual([]);
		// A relaunch then has nothing to bring back.
		await redeliverSends(outbox, omp("omp-b").deps);
		expect(withdrawn.prompts).toEqual([]);
	});

	it("keeps the order: a later message waits while an earlier one cannot be handed over", async () => {
		const outbox = new SendOutbox(null, () => 2_000);
		for (const n of [2, 3]) {
			outbox.keep(sent(n));
			outbox.handed(sent(n), "omp-a");
		}
		const refusing = omp("omp-b");
		refusing.deps.prompt = async (_tabId, entry) => {
			refusing.prompts.push(entry.mark);
			return "refused";
		};
		expect(await deliverOwed(outbox, refusing.deps, "/s/kid.jsonl", undefined)).toBe(false);
		expect(refusing.prompts).toEqual(["[ompdesk dispatch d2:"]);
		const taking = omp("omp-b");
		expect(await deliverOwed(outbox, taking.deps, "/s/kid.jsonl", undefined)).toBe(true);
		expect(taking.prompts).toEqual(["[ompdesk dispatch d2:", "[ompdesk dispatch d3:"]);
	});

	it("waits while no tab holds the receiver or its bridge cannot answer, and looks for a paired device's session by device", async () => {
		const outbox = new SendOutbox(null, () => 2_000);
		outbox.keep(sent(2, { device: "dev-1", instance: "omp-a" }));
		const looked: Array<[string, string | undefined]> = [];
		const none = omp("omp-b");
		none.deps.tabOf = (sessionPath, device) => {
			looked.push([sessionPath, device]);
			return undefined;
		};
		await redeliverSends(outbox, none.deps);
		const mute = omp("omp-b");
		mute.deps.sent = async () => null;
		await redeliverSends(outbox, mute.deps);
		expect(looked).toEqual([["/s/kid.jsonl", "dev-1"]]);
		expect([...none.prompts, ...mute.prompts]).toEqual([]);
		expect(outbox.pending()).toHaveLength(1);
	});

	it("numbers past a dispatch still owed, and recognizes the same message from the same sender", () => {
		const outbox = new SendOutbox(null, () => 2_000);
		outbox.keep(sent(4));
		outbox.keep(sent(1, { mark: "[ompdesk request m-1]", dispatch: undefined, sessionPath: "/s/other.jsonl" }));
		expect(outbox.lastDispatch("/s/kid.jsonl", undefined)).toBe(4);
		expect(outbox.lastDispatch("/s/kid.jsonl", "dev-1")).toBe(0);
		expect(outbox.waiting("/s/boss.jsonl", "/s/kid.jsonl", undefined, "do part 4")?.dispatch).toBe(4);
		expect(outbox.waiting("/s/else.jsonl", "/s/kid.jsonl", undefined, "do part 4")).toBeUndefined();
	});
});
