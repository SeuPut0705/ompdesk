import { randomBytes } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameOpener, FrameSealer, Link, MAX_FRAME_BYTES, type WireMessage } from "./wire";

const sockets: Socket[] = [];

afterEach(() => {
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
