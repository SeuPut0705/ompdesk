import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAIL_OUTBOX_MAX,
	MAIL_OUTBOX_TTL_MS,
	MailOutbox,
	needsOutbox,
	type OutboxMail,
	redeliverMail,
} from "./mail-outbox";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileIn(): string {
	const dir = mkdtempSync(join(tmpdir(), "mail-outbox-"));
	dirs.push(dir);
	return join(dir, "mail-outbox.json");
}

function entry(id: string, over: Partial<OutboxMail> = {}): OutboxMail {
	return {
		id,
		sessionPath: "/s/boss.jsonl",
		content: `<ompdesk-mail>${id}</ompdesk-mail>`,
		details: { id, kind: "done" },
		delivery: { triggerTurn: true, deliverAs: "followUp" },
		at: 1_000,
		...over,
	};
}

describe("needsOutbox", () => {
	it("holds only what stock queues in memory: a follow-up that triggers a turn", () => {
		expect(needsOutbox({ triggerTurn: true, deliverAs: "followUp" })).toBe(true);
		// An aside is journaled at once (installed omp, bridge-agent-mail-restart-stock.test.ts); no-turn reports are not turns.
		expect(needsOutbox({ triggerTurn: true, deliverAs: "aside" })).toBe(false);
		expect(needsOutbox({ triggerTurn: false })).toBe(false);
	});
});

describe("MailOutbox", () => {
	it("keeps a report across a relaunch until it is settled", () => {
		const file = fileIn();
		new MailOutbox(file, () => 2_000).keep(entry("a", { device: "dev-1" }));
		const reopened = new MailOutbox(file, () => 2_000);
		expect(reopened.pending()).toEqual([entry("a", { device: "dev-1" })]);
		reopened.settle("a");
		expect(new MailOutbox(file, () => 2_000).pending()).toEqual([]);
	});

	it("keeps a repeated id once", () => {
		const outbox = new MailOutbox(null, () => 2_000);
		outbox.keep(entry("a"));
		outbox.keep(entry("a", { content: "newer" }));
		expect(outbox.pending().map(mail => mail.content)).toEqual(["newer"]);
	});

	it("drops a report older than its age and the oldest past the bound", () => {
		const outbox = new MailOutbox(null, () => MAIL_OUTBOX_TTL_MS + 5_000);
		outbox.keep(entry("old", { at: 1_000 }));
		for (let n = 0; n < MAIL_OUTBOX_MAX + 3; n++) outbox.keep(entry(`m${n}`, { at: MAIL_OUTBOX_TTL_MS }));
		const ids = outbox.pending().map(mail => mail.id);
		expect(ids).toHaveLength(MAIL_OUTBOX_MAX);
		expect(ids[0]).toBe("m3");
		expect(ids).not.toContain("old");
	});

	it("ignores a damaged file and the entries in it that are not reports", () => {
		const file = fileIn();
		writeFileSync(file, JSON.stringify([entry("ok"), { id: "no-path" }, null, "x"]));
		expect(new MailOutbox(file, () => 2_000).pending().map(mail => mail.id)).toEqual(["ok"]);
		writeFileSync(file, "{not json");
		expect(new MailOutbox(file).pending()).toEqual([]);
	});

	it("writes the file when a report is kept, not later", () => {
		const file = fileIn();
		new MailOutbox(file, () => 2_000).keep(entry("a"));
		expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
	});
});

describe("redeliverMail", () => {
	it("asks the tab that holds the receiver's session now, and settles once its journal holds the report", async () => {
		const outbox = new MailOutbox(null, () => 2_000);
		outbox.keep(entry("a"));
		const sent: string[] = [];
		const answers: Array<{ duplicate?: boolean; journaled?: boolean } | undefined> = [
			{},
			{ duplicate: true, journaled: false },
			{ duplicate: true, journaled: true },
		];
		const deps = {
			tabOf: (sessionPath: string) => (sessionPath === "/s/boss.jsonl" ? "tab9" : undefined),
			send: async (tabId: string, mail: OutboxMail) => {
				sent.push(`${tabId}:${mail.id}`);
				return answers.shift();
			},
		};
		await redeliverMail(outbox, deps);
		await redeliverMail(outbox, deps);
		expect(outbox.pending()).toHaveLength(1);
		await redeliverMail(outbox, deps);
		expect(outbox.pending()).toEqual([]);
		expect(sent).toEqual(["tab9:a", "tab9:a", "tab9:a"]);
	});

	it("leaves a report whose receiver has no tab, and one whose omp cannot be asked, for the next pass", async () => {
		const outbox = new MailOutbox(null, () => 2_000);
		outbox.keep(entry("closed", { sessionPath: "/s/closed.jsonl" }));
		outbox.keep(entry("starting"));
		const sent: string[] = [];
		await redeliverMail(outbox, {
			tabOf: sessionPath => (sessionPath === "/s/boss.jsonl" ? "tab9" : undefined),
			send: async (tabId, mail) => {
				sent.push(`${tabId}:${mail.id}`);
				throw new Error("starting");
			},
		});
		expect(sent).toEqual(["tab9:starting"]);
		expect(outbox.pending().map(mail => mail.id)).toEqual(["closed", "starting"]);
	});

	it("looks for a paired device's session by its device", async () => {
		const outbox = new MailOutbox(null, () => 2_000);
		outbox.keep(entry("a", { device: "dev-1" }));
		const looked: Array<[string, string | undefined]> = [];
		await redeliverMail(outbox, {
			tabOf: (sessionPath, device) => {
				looked.push([sessionPath, device]);
				return undefined;
			},
			send: async () => undefined,
		});
		expect(looked).toEqual([["/s/boss.jsonl", "dev-1"]]);
	});
});
