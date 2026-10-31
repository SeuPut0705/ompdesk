import { afterEach, describe, expect, it } from "vitest";
import { type FakeImap, startFakeImap } from "./fake-imap";
import { decodeWords, ImapError, readMailbox } from "./imap";

let server: FakeImap | null = null;
afterEach(async () => {
	await server?.close();
	server = null;
});

async function fake(): Promise<FakeImap> {
	server = await startFakeImap();
	return server;
}

const login = (imap: FakeImap) => ({ username: imap.state.user, password: imap.state.password, mailbox: "INBOX" });

describe("readMailbox (IMAP over a fake server)", () => {
	it("takes the mailbox's place as its baseline, then reads only the mail after it, unread", async () => {
		const imap = await fake();
		imap.mail.push({ uid: 3, headers: "From: Old <old@example.com>\r\nSubject: before" });
		const first = await readMailbox(imap.connect, login(imap), null);
		expect(first).toEqual({ cursor: { validity: 7, uid: 3 }, messages: [], exists: 1 });

		imap.mail.push(
			{
				uid: 4,
				headers: "From: Ann <ann@example.com>\r\nTo: owner+bot@example.com\r\nSubject: =?UTF-8?B?7ZWc6riA?= build",
				body: "Please rerun the nightly.",
			},
			{ uid: 5, headers: "From: bob@example.com\r\nSubject: second", body: "two" },
		);
		const second = await readMailbox(imap.connect, login(imap), first.cursor);
		expect(second.cursor).toEqual({ validity: 7, uid: 5 });
		expect(second.messages.map(message => [message.uid, message.headers.subject, message.snippet])).toEqual([
			[4, "한글 build", "Please rerun the nightly."],
			[5, "second", "two"],
		]);
		expect(second.messages[0]?.headers.to).toBe("owner+bot@example.com");
		// Read-only and nothing marked seen.
		expect(imap.commands.some(line => / EXAMINE "INBOX"$/.test(line))).toBe(true);
		expect(imap.commands.filter(line => / UID FETCH /.test(line)).every(line => line.includes("BODY.PEEK"))).toBe(
			true,
		);

		// Nothing new: `n:*` answers the newest old message, which is not new.
		const third = await readMailbox(imap.connect, login(imap), second.cursor);
		expect(third.messages).toEqual([]);
		expect(third.cursor).toEqual({ validity: 7, uid: 5 });
	});

	it("takes a new baseline when the mailbox was recreated (another UIDVALIDITY)", async () => {
		const imap = await fake();
		imap.mail.push({ uid: 1, headers: "Subject: a" });
		const first = await readMailbox(imap.connect, login(imap), null);
		imap.state.validity = 8;
		imap.mail.push({ uid: 2, headers: "Subject: b" });
		const second = await readMailbox(imap.connect, login(imap), first.cursor);
		expect(second).toMatchObject({ cursor: { validity: 8, uid: 2 }, messages: [] });
	});

	it("quotes the login, and a refused one fails with the server's words and never the password", async () => {
		const imap = await fake();
		await readMailbox(imap.connect, login(imap), null);
		expect(imap.commands[0]).toBe('A1 LOGIN "owner@example.com" "s3cret \\"pw\\""');
		const refused = await readMailbox(imap.connect, { ...login(imap), password: "wrong-password" }, null).catch(
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(ImapError);
		expect((refused as Error).message).toBe("could not login: [AUTHENTICATIONFAILED] Invalid credentials");
		expect((refused as Error).message).not.toContain("wrong-password");
		await expect(readMailbox(imap.connect, { ...login(imap), mailbox: "Nope" }, null)).rejects.toThrow(
			"could not open the mailbox: [NONEXISTENT] no such mailbox",
		);
		await expect(readMailbox(imap.connect, { ...login(imap), password: "a\r\nA9 LOGOUT" }, null)).rejects.toThrow(
			"line break",
		);
	});

	it("reads the plain text part of a multipart mail and decodes quoted-printable and base64", async () => {
		const imap = await fake();
		const first = await readMailbox(imap.connect, login(imap), null);
		imap.mail.push(
			{
				uid: 1,
				headers: 'Subject: mixed\r\nContent-Type: multipart/alternative; boundary="b1"',
				body: [
					"--b1",
					"Content-Type: text/plain; charset=utf-8",
					"Content-Transfer-Encoding: quoted-printable",
					"",
					"Caf=C3=A9 is =",
					"open",
					"--b1",
					"Content-Type: text/html",
					"",
					"<p>ignored</p>",
					"--b1--",
				].join("\r\n"),
			},
			{
				uid: 2,
				headers: "Subject: b64\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64",
				body: Buffer.from("안녕하세요").toString("base64"),
			},
		);
		const read = await readMailbox(imap.connect, login(imap), first.cursor);
		expect(read.messages.map(message => message.snippet)).toEqual(["Café is open", "안녕하세요"]);
	});

	it("fails in time when the server says nothing", async () => {
		const imap = await fake();
		imap.state.greeting = "";
		await expect(readMailbox(imap.connect, login(imap), null, 200)).rejects.toThrow(/did not (answer in time|greet)/);
	});
});

describe("decodeWords", () => {
	it("decodes B and Q words and joins adjacent ones", () => {
		expect(decodeWords("=?UTF-8?B?7ZWc?= =?UTF-8?B?6riA?= mail")).toBe("한글 mail");
		expect(decodeWords("=?iso-8859-1?Q?Caf=E9_ouvert?=")).toBe("Café ouvert");
		expect(decodeWords("plain")).toBe("plain");
	});
});
