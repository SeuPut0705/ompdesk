/**
 * A fake IMAP server for the email routine's tests: plain TCP on localhost, one mailbox the test fills, and just the
 * commands the client sends (LOGIN, EXAMINE, UID SEARCH, UID FETCH, LOGOUT), answered as RFC 9051 servers do
 * (`n:*` includes the newest message even when it is below `n`). It records every command line it was sent.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

export interface FakeMail {
	uid: number;
	/** Header lines, CRLF-joined; sent for HEADER.FIELDS whatever fields were asked. */
	headers: string;
	body?: string;
}

export interface FakeImap {
	port: number;
	mail: FakeMail[];
	/** Changing it is what a recreated mailbox looks like to a client. */
	state: { validity: number; user: string; password: string; mailbox: string; greeting: string };
	commands: string[];
	connect(): Promise<Socket>;
	close(): Promise<void>;
}

export async function startFakeImap(): Promise<FakeImap> {
	const fake: Omit<FakeImap, "port" | "connect" | "close"> = {
		mail: [],
		state: {
			validity: 7,
			user: "owner@example.com",
			password: 's3cret "pw"',
			mailbox: "INBOX",
			greeting: "* OK fake ready",
		},
		commands: [],
	};
	const server: Server = createServer(socket => serve(socket, fake));
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		...fake,
		port,
		connect: () => {
			const { promise, resolve, reject } = Promise.withResolvers<Socket>();
			const socket = connect(port, "127.0.0.1", () => resolve(socket));
			socket.once("error", reject);
			return promise;
		},
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
	};
}

function unquote(word: string): string {
	return word.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");
}

/** The quoted strings of a command line, in order. */
function quoted(line: string): string[] {
	return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => unquote(`"${match[1] ?? ""}"`));
}

function serve(socket: Socket, fake: Omit<FakeImap, "port" | "connect" | "close">): void {
	socket.write(`${fake.state.greeting}\r\n`);
	let buffer = "";
	let authed = false;
	socket.on("data", chunk => {
		buffer += chunk.toString("utf8");
		for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			fake.commands.push(line);
			const [tag = "*", verb = "", ...rest] = line.split(" ");
			const command = verb.toUpperCase() === "UID" ? `UID ${(rest[0] ?? "").toUpperCase()}` : verb.toUpperCase();
			const send = (text: string) => socket.write(`${text}\r\n`);
			switch (command) {
				case "LOGIN": {
					const [user, password] = quoted(line);
					if (user === fake.state.user && password === fake.state.password) {
						authed = true;
						send(`${tag} OK LOGIN completed`);
					} else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
					break;
				}
				case "EXAMINE": {
					if (!authed) return send(`${tag} BAD not logged in`);
					if (quoted(line)[0] !== fake.state.mailbox) return send(`${tag} NO [NONEXISTENT] no such mailbox`);
					const next = Math.max(0, ...fake.mail.map(mail => mail.uid)) + 1;
					send(`* ${fake.mail.length} EXISTS`);
					send(`* OK [UIDVALIDITY ${fake.state.validity}] UIDs valid`);
					send(`* OK [UIDNEXT ${next}] Predicted next UID`);
					send(`${tag} OK [READ-ONLY] EXAMINE completed`);
					break;
				}
				case "UID SEARCH": {
					const spec = rest.slice(1).join(" ");
					const uids = fake.mail.map(mail => mail.uid).toSorted((a, b) => a - b);
					let found = uids;
					const range = /^UID (\d+):\*$/i.exec(spec);
					if (range) {
						const from = Number(range[1]);
						const newest = uids.at(-1);
						found = uids.filter(uid => uid >= from);
						if (found.length === 0 && newest !== undefined) found = [newest];
					}
					send(`* SEARCH${found.map(uid => ` ${uid}`).join("")}`);
					send(`${tag} OK SEARCH completed`);
					break;
				}
				case "UID FETCH": {
					const set = (rest[1] ?? "").split(",").map(Number);
					fake.mail
						.filter(mail => set.includes(mail.uid))
						.forEach((mail, index) => {
							const headers = Buffer.from(`${mail.headers}\r\n\r\n`, "utf8");
							const body = Buffer.from(mail.body ?? "", "utf8");
							socket.write(
								Buffer.concat([
									Buffer.from(
										`* ${index + 1} FETCH (UID ${mail.uid} BODY[HEADER.FIELDS (FROM TO SUBJECT)] {${headers.length}}\r\n`,
									),
									headers,
									Buffer.from(` BODY[TEXT]<0> {${body.length}}\r\n`),
									body,
									Buffer.from(")\r\n"),
								]),
							);
						});
					send(`${tag} OK FETCH completed`);
					break;
				}
				case "LOGOUT":
					send("* BYE logging out");
					send(`${tag} OK LOGOUT completed`);
					socket.end();
					break;
				default:
					send(`${tag} BAD unknown command`);
			}
		}
	});
	socket.on("error", () => undefined);
}
