/**
 * The link the core runs (`crates/core/src/remote/link.rs`) against the link every released TypeScript build runs
 * (`test-legacy-peer.ts`), over a real loopback socket, both ways: a computer on an older release talks to this one's
 * core. The core's end is `remote.testLink` (keys the test chose, no handshake); main holds it as `Link`.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "../core/process";
import { encodeFrame, FrameSealer, Link as LegacyLink, type WireMessage as LegacyMessage } from "./test-legacy-peer";
import { FrameTooLargeError, Link, MAX_FRAME_BYTES, WAKE_CHECK_MS, type WireMessage } from "./wire";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Pair {
	/** The core's end, as main holds it. */
	core: Link;
	/** A released TypeScript peer's end. */
	peer: LegacyLink;
	socket: Socket;
	/** The peer's keys: what it sends under, what it opens with. */
	keys: { send: Buffer; receive: Buffer };
}

/** A core link dialed to a legacy peer; both sealed (`secure`) unless told otherwise. */
async function pair(options: { secure?: boolean; liveness?: { pingMs: number; deadMs: number } } = {}): Promise<Pair> {
	const accepted = Promise.withResolvers<Socket>();
	const server: Server = createServer(socket => accepted.resolve(socket));
	const listening = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		listening.resolve(typeof address === "object" && address ? address.port : 0);
	});
	const port = await listening.promise;
	const keys = { send: randomBytes(32), receive: randomBytes(32) };
	const secure = options.secure !== false;
	const { result } = await core().call<{ link: number }>("remote.testLink", {
		address: `127.0.0.1:${port}`,
		...(secure ? { sendKey: keys.receive.toString("hex"), receiveKey: keys.send.toString("hex") } : {}),
		...(options.liveness ? { liveness: options.liveness } : {}),
	});
	const socket = await accepted.promise;
	server.close();
	const peer = new LegacyLink(socket);
	if (secure) peer.secure(keys.send, keys.receive);
	const link = new Link(result.link);
	cleanups.push(() => {
		link.destroy();
		peer.destroy();
	});
	return { core: link, peer, socket, keys };
}

function collect(link: { listen(onMessage: (message: WireMessage | LegacyMessage) => void): void }, count: number) {
	const got: object[] = [];
	const done = Promise.withResolvers<object[]>();
	link.listen(message => {
		got.push(message);
		if (got.length === count) done.resolve(got);
	});
	return done.promise;
}

function closed(link: Link): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	link.onClose(() => resolve(link.closeReason));
	return promise;
}

/** A live stream as a busy tab sends it: small updates that repeat what came before, then a large read. */
function stream(): object[] {
	const messages: object[] = [];
	let text = "";
	for (let n = 0; n < 60; n++) {
		text += `token ${n} of the reply, reading src/main/remote/host-services.ts for emit( `;
		messages.push({
			t: "evt",
			event: "tab.event",
			data: { name: "events", arg: [{ type: "message_update", text }] },
		});
	}
	messages.push({ t: "res", id: 1, ok: true, result: { page: "x".repeat(70_000), rows: [1, 2, 3] } });
	messages.push({ t: "ping-like", n: 1 });
	return messages;
}

describe("a core link and a released TypeScript link on one socket", () => {
	it("opens what the other sealed, both ways, in order", async () => {
		const { core: link, peer } = await pair();
		const fromPeer = collect(link, 3);
		const fromCore = collect(peer, 3);
		for (let n = 1; n <= 3; n++) peer.send({ t: "secret", n, text: "ü ☃ 😀" });
		for (let n = 1; n <= 3; n++) link.send({ t: "answer", n });
		expect(await fromPeer).toEqual([1, 2, 3].map(n => ({ t: "secret", n, text: "ü ☃ 😀" })));
		expect(await fromCore).toEqual([1, 2, 3].map(n => ({ t: "answer", n })));
	});

	it("a stream deflated against the context crosses whole both ways", async () => {
		const { core: link, peer } = await pair();
		const messages = stream();
		const toPeer = collect(peer, messages.length);
		link.deflateSent({ context: true });
		for (const message of messages) link.send(message);
		expect(await toPeer).toEqual(messages);

		const toCore = collect(link, messages.length);
		peer.deflateSent({ context: true });
		for (const message of messages) peer.send(message);
		expect(await toCore).toEqual(messages);
	});

	it("a stream of frames each deflated alone crosses whole both ways", async () => {
		const { core: link, peer } = await pair();
		const messages = stream();
		const toPeer = collect(peer, messages.length);
		link.deflateSent();
		for (const message of messages) link.send(message);
		expect(await toPeer).toEqual(messages);
		const toCore = collect(link, messages.length);
		peer.deflateSent();
		for (const message of messages) peer.send(message);
		expect(await toCore).toEqual(messages);
	});

	it("answers the peer's pings, and the peer answers its own", async () => {
		const { core: link, peer } = await pair({ liveness: { pingMs: 20, deadMs: 2_000 } });
		peer.listen(() => {});
		link.listen(() => {});
		expect(await peer.check(WAKE_CHECK_MS)).toBe(true);
		expect(await link.check(WAKE_CHECK_MS)).toBe(true);
		expect(link.closed).toBe(false);
	});

	it("drops a peer that stops answering pings (`dead`)", async () => {
		// The peer never listens, so no pong ever comes back.
		const { core: link } = await pair({ liveness: { pingMs: 10, deadMs: 40 } });
		const reason = closed(link);
		link.listen(() => {});
		expect(await reason).toBe("dead");
	});

	it("a check on a peer that went silent drops the link (`dead`) and answers false", async () => {
		const { core: link } = await pair();
		link.listen(() => {});
		const reason = closed(link);
		expect(await link.check(200)).toBe(false);
		expect(await reason).toBe("dead");
	});

	it("says why it closed: the peer ended the connection", async () => {
		const { core: link, peer } = await pair();
		link.listen(() => {});
		const reason = closed(link);
		peer.destroy();
		expect(await reason).toBe("closed");
	});

	it("a graceful close flushes what was sent, then ends as `local`", async () => {
		const { core: link, peer, socket } = await pair();
		const got = collect(peer, 1);
		link.listen(() => {});
		const reason = closed(link);
		const ended = once(socket, "end");
		link.send({ t: "last" });
		link.close();
		expect(await got).toEqual([{ t: "last" }]);
		// The core ends its side once the close went through; only then does the peer go, so its end is read as the
		// answer to a close and never as a peer that left first (the frame can reach the peer before the core reads
		// main's close).
		await ended;
		peer.destroy();
		expect(await reason).toBe("local");
	});

	it("refuses to send a message past the frame cap and sends nothing", async () => {
		const { core: link, peer } = await pair();
		const got = collect(peer, 1);
		expect(() => link.send({ t: "big", pad: "x".repeat(MAX_FRAME_BYTES) })).toThrow(FrameTooLargeError);
		link.send({ t: "after" });
		expect(await got).toEqual([{ t: "after" }]);
	});
});

describe("what the core refuses from a peer (`protocol`)", () => {
	async function refused(write: (pair: Pair) => void, options: { secure?: boolean } = {}): Promise<string | null> {
		const both = await pair(options);
		both.core.listen(() => {});
		const reason = closed(both.core);
		write(both);
		return reason;
	}

	it("a frame whose tag fails", async () => {
		const reason = await refused(({ socket, keys }) => {
			const sealed = new FrameSealer(keys.send).seal(Buffer.from('{"t":"x"}'));
			sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
			socket.write(encodeFrame(sealed));
		});
		expect(reason).toBe("protocol");
	});

	it("a counter that does not increase", async () => {
		const reason = await refused(({ socket, keys }) => {
			const sealer = new FrameSealer(keys.send);
			const first = sealer.seal(Buffer.from('{"t":"x"}'));
			socket.write(encodeFrame(first));
			socket.write(encodeFrame(first));
		});
		expect(reason).toBe("protocol");
	});

	it("a frame header past 16 MiB", async () => {
		const reason = await refused(({ socket }) => {
			const header = Buffer.alloc(4);
			header.writeUInt32BE(MAX_FRAME_BYTES + 1);
			socket.write(header);
		});
		expect(reason).toBe("protocol");
	});

	it("a deflated frame that inflates past 16 MiB", async () => {
		const reason = await refused(({ socket, keys }) => {
			const bomb = Buffer.concat([Buffer.of(0x00), deflateRawSync(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20))]);
			socket.write(encodeFrame(new FrameSealer(keys.send).seal(bomb)));
		});
		expect(reason).toBe("protocol");
	});

	it("a deflated frame of either kind before the link is secure, never inflated", async () => {
		for (const marker of [0x00, 0x01]) {
			const reason = await refused(
				({ socket }) => {
					socket.write(encodeFrame(Buffer.concat([Buffer.of(marker), deflateRawSync(Buffer.from('{"t":"x"}'))])));
				},
				{ secure: false },
			);
			expect(reason).toBe("protocol");
		}
	});

	it("JSON that is no object, or an object without a string `t`", async () => {
		for (const body of ["[1]", '{"t":1}', "not json"]) {
			const reason = await refused(({ socket, keys }) => {
				socket.write(encodeFrame(new FrameSealer(keys.send).seal(Buffer.from(body))));
			});
			expect(reason).toBe("protocol");
		}
	});
});
