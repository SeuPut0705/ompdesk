import { randomBytes } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFLATE_MIN_BYTES,
	encodeFrame,
	FrameDecoder,
	FrameOpener,
	FrameSealer,
	Link,
	MAX_FRAME_BYTES,
	WAKE_CHECK_MS,
	type WireMessage,
} from "./wire";

const sockets: Socket[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const socket of sockets.splice(0)) socket.destroy();
});

/** Both ends of a real loopback TCP connection. */
async function socketPair(): Promise<[Socket, Socket]> {
	const { promise: accepted, resolve: accept } = Promise.withResolvers<Socket>();
	const server = createServer(accept);
	const { promise: listening, resolve: ready } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		ready(typeof address === "object" && address ? address.port : 0);
	});
	const client = connect({ host: "127.0.0.1", port: await listening });
	const serverSide = await accepted;
	server.close();
	sockets.push(client, serverSide);
	return [client, serverSide];
}

describe("Link", () => {
	it("switches to encrypted frames and delivers messages queued across the switch", async () => {
		const [left, right] = await socketPair();
		const a = new Link(left);
		const b = new Link(right);
		const [ab, ba] = [randomBytes(32), randomBytes(32)];
		a.send({ t: "plain" });
		expect(await b.receive(1_000)).toEqual({ t: "plain" });
		a.secure(ab, ba);
		b.secure(ba, ab);
		a.send({ t: "secret", n: 1 });
		a.send({ t: "secret", n: 2 });
		const got: WireMessage[] = [];
		const { promise: two, resolve } = Promise.withResolvers<void>();
		b.listen(message => {
			got.push(message);
			if (got.length === 2) resolve();
		});
		await two;
		expect(got).toEqual([
			{ t: "secret", n: 1 },
			{ t: "secret", n: 2 },
		]);
	});

	it("drops a peer that stops answering pings", async () => {
		const [left] = await socketPair();
		// The other end never reads, so no pong ever comes back.
		const link = new Link(left, { pingMs: 10, deadMs: 40 });
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		link.onClose(resolve);
		link.listen(() => {});
		await closed;
		expect(link.closed).toBe(true);
	});

	it("says why it closed: the peer ended the connection", async () => {
		const [left, right] = await socketPair();
		const link = new Link(left);
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		link.onClose(resolve);
		link.listen(() => {});
		right.destroy();
		await closed;
		expect(link.closeReason).toBe("closed");
	});

	it("a check on a peer that went silent drops the link when its window passes, not before", async () => {
		const [left] = await socketPair();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		const link = new Link(left);
		link.listen(() => {});

		const answered = link.check(WAKE_CHECK_MS);
		await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS - 1);
		expect(link.closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(link.closed).toBe(true);
		expect(link.closeReason).toBe("dead");
		expect(await answered).toBe(false);
	});

	it("a check on a live peer is answered and leaves the link open", async () => {
		const [left, right] = await socketPair();
		const a = new Link(left);
		const b = new Link(right);
		a.listen(() => {});
		b.listen(() => {});
		expect(await a.check(WAKE_CHECK_MS)).toBe(true);
		expect(a.closed).toBe(false);
	});
});

describe("deflated frames", () => {
	/** A secured pair whose `a` deflates what it sends, with the wire bytes of each frame `a` sent. */
	async function deflatingPair(deflate = true) {
		const [left, right] = await socketPair();
		const a = new Link(left);
		const b = new Link(right);
		const [ab, ba] = [randomBytes(32), randomBytes(32)];
		a.secure(ab, ba);
		b.secure(ba, ab);
		if (deflate) a.deflateSent();
		const sent: number[] = [];
		a.onTraffic((direction, _message, bytes) => {
			if (direction === "tx") sent.push(bytes);
		});
		const got: WireMessage[] = [];
		b.listen(message => got.push(message));
		return { a, b, sent, got, left, right };
	}

	it("a large message crosses deflated and arrives as sent; a small one crosses as it is", async () => {
		const { a, sent, got } = await deflatingPair();
		const large = {
			t: "evt",
			rows: Array.from({ length: 400 }, (_, n) => ({ id: n, title: `cycle ${n}`, state: "green" })),
		};
		const small = { t: "evt", n: 1 };
		a.send(large);
		a.send(small);
		await vi.waitFor(() => expect(got).toHaveLength(2));
		expect(got).toEqual([large, small]);
		const [largeBytes, smallBytes] = sent as [number, number];
		expect(largeBytes * 3).toBeLessThan(JSON.stringify(large).length);
		expect(JSON.stringify(small).length).toBeLessThan(DEFLATE_MIN_BYTES);
		// Header, nonce and tag around the JSON itself: nothing was deflated.
		expect(smallBytes).toBe(JSON.stringify(small).length + 4 + 12 + 16);
	});

	it("a link whose peer never asked sends every message as JSON", async () => {
		const { a, sent, got } = await deflatingPair(false);
		const large = { t: "evt", pad: "x".repeat(50_000) };
		a.send(large);
		await vi.waitFor(() => expect(got).toHaveLength(1));
		expect(sent[0]).toBeGreaterThan(50_000);
	});

	it("drops a peer whose deflated frame inflates past the frame cap", async () => {
		const [left, right] = await socketPair();
		const b = new Link(right);
		const closed = Promise.withResolvers<void>();
		b.onClose(() => closed.resolve());
		b.listen(() => {});
		const bomb = deflateRawSync(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20));
		left.write(encodeFrame(Buffer.concat([Buffer.of(0), bomb])));
		await closed.promise;
		expect(b.closeReason).toBe("protocol");
	});
});

describe("FrameDecoder", () => {
	it("reassembles frames split across and packed into chunks", () => {
		const a = encodeFrame(Buffer.from("first"));
		const b = encodeFrame(Buffer.from("second"));
		const stream = Buffer.concat([a, b]);
		const decoder = new FrameDecoder();
		const frames = [
			...decoder.push(stream.subarray(0, 2)),
			...decoder.push(stream.subarray(2, 7)),
			...decoder.push(stream.subarray(7)),
		];
		expect(frames.map(frame => frame.toString())).toEqual(["first", "second"]);
	});

	it("rejects a length over the 16 MiB cap before buffering it", () => {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(MAX_FRAME_BYTES + 1);
		expect(() => new FrameDecoder().push(header)).toThrow(/16 MiB/);
		expect(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow(/16 MiB/);
	});
});

describe("FrameSealer / FrameOpener", () => {
	const key = randomBytes(32);

	it("round-trips and requires strictly increasing counters", () => {
		const sealer = new FrameSealer(key);
		const opener = new FrameOpener(key);
		const first = sealer.seal(Buffer.from("one"));
		const second = sealer.seal(Buffer.from("two"));
		expect(opener.open(first).toString()).toBe("one");
		expect(opener.open(second).toString()).toBe("two");
		expect(() => opener.open(second)).toThrow(/counter/);
		expect(() => opener.open(first)).toThrow(/counter/);
	});

	it("rejects a tampered frame or the wrong key", () => {
		const frame = new FrameSealer(key).seal(Buffer.from("payload"));
		const tampered = Buffer.from(frame);
		tampered[14] = (tampered[14] ?? 0) ^ 1;
		expect(() => new FrameOpener(key).open(tampered)).toThrow();
		expect(() => new FrameOpener(randomBytes(32)).open(frame)).toThrow();
	});
});
