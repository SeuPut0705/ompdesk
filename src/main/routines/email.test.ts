import { afterEach, describe, expect, it } from "vitest";
import { createEmailSource, type EmailSourceOptions, type MailPort } from "./email";
import { type FakeImap, type FakeMail, startFakeImap } from "./fake-imap";
import { readMailbox } from "./imap";
import type { RoutineSource } from "./source";
import { fakeContext } from "./test-context";

const PASSWORD = 's3cret "pw"';

let server: FakeImap | null = null;
let source: RoutineSource | null = null;
afterEach(async () => {
	source?.stop();
	source = null;
	await server?.close();
	server = null;
});

const mail = (uid: number, headers: string[], body = "") => ({ uid, headers: headers.join("\r\n"), body });

/**
 * A source on a fake IMAP server, read the way the production port does, for the account "Work" (id acc1). `polls(n)`
 * settles once the n-th poll began, so every poll before it has finished: tests wait on polls, not on the clock.
 */
async function rig(
	options: Partial<EmailSourceOptions> & { named?: () => boolean; already?: FakeMail[]; mark?: unknown } = {},
) {
	server = await startFakeImap();
	const imap = server;
	imap.mail.push(...(options.already ?? []));
	const ctx = fakeContext(options.mark);
	let started = 0;
	const waiters: { count: number; resolve: () => void }[] = [];
	const mailPort: MailPort = {
		account: name => {
			started++;
			for (const waiter of waiters.filter(item => started >= item.count)) waiter.resolve();
			if (options.named && !options.named()) return null;
			return ["acc1", "work"].includes(name.toLowerCase())
				? { id: "acc1", label: "Work", address: "owner@example.com" }
				: null;
		},
		read: (_id, cursor) =>
			readMailbox(imap.connect, { username: imap.state.user, password: PASSWORD, mailbox: "INBOX" }, cursor),
	};
	const polls = (count: number) => {
		if (started >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		return promise;
	};
	source = createEmailSource({ account: "Work", mail: mailPort, context: ctx.context, pollMs: 5, ...options });
	return { imap, ...ctx, polls, polled: () => started };
}

describe("the email trigger across a relaunch", () => {
	it("fires once for mail that came while OMPdesk was closed, and keeps the cursor before it fires", async () => {
		const { fired, polls, saved } = await rig({
			mark: { accountId: "acc1", validity: 7, uid: 1 },
			already: [
				mail(1, ["From: old@example.com", "Subject: before"]),
				mail(2, ["From: Ann <ann@example.com>", "To: owner@example.com", "Subject: while closed"], "hello"),
			],
		});
		await polls(3);
		expect(fired).toEqual([
			'New mail in Work from Ann <ann@example.com> to owner@example.com: "while closed". It begins: hello',
		]);
		expect(saved[0]).toEqual({ accountId: "acc1", validity: 7, uid: 2 });
	});

	it("takes a baseline when the mark is for another mailbox generation", async () => {
		const { fired, polls } = await rig({
			mark: { accountId: "acc1", validity: 6, uid: 0 },
			already: [mail(1, ["From: old@example.com", "Subject: before"])],
		});
		await polls(3);
		expect(fired).toEqual([]);
	});
});

describe("the email trigger", () => {
	it("never fires for mail already there, then fires once per new mail, oldest first, with what it says", async () => {
		const { imap, fired, polls, polled } = await rig({
			already: [mail(1, ["From: old@example.com", "Subject: before"])],
		});
		await polls(2);
		expect(fired).toEqual([]);

		imap.mail.push(
			mail(
				2,
				[
					"From: Ann <ann@example.com>",
					"To: owner+bot@example.com",
					"Subject: Nightly failed",
					"Date: Sun, 1 Nov 2026 09:00:00 +0900",
				],
				"The nightly build failed on main.",
			),
			mail(3, ["From: bob@example.com", "To: owner@example.com", "Subject: lunch"], "noodles?"),
		);
		await polls(polled() + 2);
		expect(fired).toEqual([
			'New mail in Work from Ann <ann@example.com> to owner+bot@example.com: "Nightly failed" (Sun, 1 Nov 2026 09:00:00 +0900). It begins: The nightly build failed on main.',
			'New mail in Work from bob@example.com to owner@example.com: "lunch". It begins: noodles?',
		]);
		await polls(polled() + 2);
		expect(fired).toHaveLength(2);
	});

	it("fires only mail matching its filters: a plus-address, a sender, words in the subject", async () => {
		const { imap, fired, polls, polled } = await rig({ to: "owner+bot@", from: "ann@", subject: "deploy" });
		await polls(2);
		imap.mail.push(
			mail(1, ["From: ann@example.com", "To: owner@example.com", "Subject: deploy please"]),
			mail(2, ["From: carl@example.com", "To: owner+bot@example.com", "Subject: deploy please"]),
			mail(3, ["From: ann@example.com", "To: owner+bot@example.com", "Subject: lunch"]),
			mail(4, ["From: Ann <ANN@example.com>", "Cc: Owner+Bot@example.com", "Subject: Deploy v2 please"]),
		);
		await polls(polled() + 2);
		expect(fired).toEqual([expect.stringContaining('"Deploy v2 please"')]);
	});

	it("never fires for its own replies or for mail a program sent (loop guards)", async () => {
		const { imap, fired, polls, polled } = await rig();
		await polls(2);
		imap.mail.push(
			mail(1, [
				"From: Owner <owner@example.com>",
				"To: ann@example.com",
				"In-Reply-To: <a@example.com>",
				"Subject: Re: build",
			]),
			mail(2, ["From: notifications@example.com", "Auto-Submitted: auto-replied", "Subject: Out of office"]),
			mail(3, ["From: owner@example.com", "To: owner+bot@example.com", "Subject: a note to my bot"]),
		);
		await polls(polled() + 2);
		expect(fired).toEqual([expect.stringContaining('"a note to my bot"')]);
	});

	it("tells a missing account or a refused login once, keeps polling, and starts from a baseline when it can read", async () => {
		let named = false;
		const { imap, fired, warned, polls, polled } = await rig({ named: () => named });
		await polls(3);
		expect(warned).toEqual([
			"email Work: read: no mail account has that name or id (Settings › Schedules › Email accounts)",
		]);
		imap.state.password = "changed on the server";
		named = true;
		await polls(polled() + 3);
		expect(warned).toEqual([
			"email Work: read: no mail account has that name or id (Settings › Schedules › Email accounts)",
			"email Work: read: could not login: [AUTHENTICATIONFAILED] Invalid credentials",
		]);
		expect(warned.join("\n")).not.toContain(PASSWORD);
		// Mail that came while it could not read is the baseline once it can.
		imap.mail.push(mail(1, ["Subject: while broken"]));
		imap.state.password = PASSWORD;
		await polls(polled() + 2);
		imap.mail.push(mail(2, ["Subject: after"]));
		await polls(polled() + 2);
		expect(fired).toEqual([expect.stringContaining('"after"')]);
	});

	it("reads nothing more once stopped", async () => {
		const { imap, fired, polls, polled } = await rig();
		await polls(2);
		source?.stop();
		const before = polled();
		imap.mail.push(mail(1, ["Subject: late"]));
		// One read already under way may still finish; it fires nothing and starts no other poll.
		const settled = Promise.withResolvers<void>();
		setImmediate(() => settled.resolve());
		await settled.promise;
		expect(polled()).toBeLessThanOrEqual(before);
		expect(fired).toEqual([]);
	});
});
