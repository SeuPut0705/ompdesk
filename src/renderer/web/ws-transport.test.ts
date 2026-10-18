import { describe, expect, it } from "vitest";
import type { WebClientFrame, WebServerFrame } from "../../shared/web-protocol";
import { UnpairedError } from "./session";
import { type WsConnectionState, type WsLike, WsTransport, type WsTransportOptions } from "./ws-transport";

class FakeSocket implements WsLike {
	readyState = 1;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	readonly sent: WebClientFrame[] = [];
	closedWith: number | null = null;
	readonly url: string;
	readonly protocols: string[];

	constructor(url: string, protocols: string[]) {
		this.url = url;
		this.protocols = protocols;
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as WebClientFrame);
	}

	close(code?: number): void {
		this.closedWith = code ?? 1000;
		this.readyState = 3;
	}

	/** The host sends a frame. */
	serve(frame: WebServerFrame): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	/** The host (or the network) closes the socket. */
	drop(code = 1006): void {
		this.readyState = 3;
		this.onclose?.({ code });
	}

	framesOf<T extends WebClientFrame["t"]>(type: T): Extract<WebClientFrame, { t: T }>[] {
		return this.sent.filter((frame): frame is Extract<WebClientFrame, { t: T }> => frame.t === type);
	}
}

class Clock {
	now = 1_000;
	#next = 1;
	readonly #timers = new Map<number, { at: number; run: () => void }>();

	setTimer = (run: () => void, ms: number): unknown => {
		const id = this.#next++;
		this.#timers.set(id, { at: this.now + ms, run });
		return id;
	};

	clearTimer = (handle: unknown): void => {
		this.#timers.delete(handle as number);
	};

	/** Advance time, firing due timers in order (each may schedule more). */
	advance(ms: number): void {
		const end = this.now + ms;
		for (;;) {
			let due: [number, { at: number; run: () => void }] | null = null;
			for (const entry of this.#timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			this.#timers.delete(due[0]);
			this.now = Math.max(this.now, due[1].at);
			due[1].run();
		}
		this.now = end;
	}

	get pending(): number {
		return this.#timers.size;
	}
}

const HELLO = (resumed = false, minClient = 1): WebServerFrame => ({
	t: "hello",
	protocol: 1,
	minClient,
	connId: "c1",
	resumed,
	features: { push: false, preview: true, upload: true, passkey: false },
});

/** Let pending microtasks (the ticket fetch) run. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(overrides: Partial<WsTransportOptions> = {}) {
	const clock = new Clock();
	const sockets: FakeSocket[] = [];
	const log = { resync: 0, outdated: 0, unpaired: 0, tickets: 0 };
	const transport = new WsTransport({
		url: "wss://mac.tail.ts.net:47831/ws",
		fetchTicket: async () => `t${++log.tickets}`,
		createSocket: (url, protocols) => {
			const socket = new FakeSocket(url, protocols);
			sockets.push(socket);
			return socket;
		},
		protocol: 1,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		now: () => clock.now,
		random: () => 0.5,
		isVisible: () => true,
		onResync: () => log.resync++,
		onOutdated: () => log.outdated++,
		onUnpaired: () => log.unpaired++,
		...overrides,
	});
	const states: WsConnectionState[] = [];
	transport.onState(state => states.push(state));
	const last = () => {
		const socket = sockets.at(-1);
		if (!socket) throw new Error("no socket");
		return socket;
	};
	return { transport, clock, sockets, log, states, last };
}

describe("WsTransport", () => {
	it("opens with the ticket subprotocol and is open after hello", async () => {
		const { transport, last, states } = setup();
		transport.start();
		await settle();
		expect(last().url).toBe("wss://mac.tail.ts.net:47831/ws");
		expect(last().protocols).toEqual(["ompdesk.v1", "ticket.t1"]);
		expect(transport.state).toBe("connecting");
		last().serve(HELLO());
		expect(transport.state).toBe("open");
		expect(states).toEqual(["connecting", "open"]);
		expect(transport.features?.upload).toBe(true);
		expect(last().framesOf("presence")).toEqual([{ t: "presence", visible: true }]);
	});

	it("answers an invoke with its result, and a failure with the code Electron would carry", async () => {
		const { transport, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const ok = transport.invoke<string>("sessions:list", "global");
		const failed = transport.invoke("fs:read", "/x");
		const [first, second] = last().framesOf("inv");
		expect(first).toEqual({ t: "inv", id: 1, ch: "sessions:list", a: ["global"] });
		last().serve({ t: "res", id: first?.id ?? 0, ok: true, v: "list" });
		last().serve({ t: "res", id: second?.id ?? 0, ok: false, e: { message: "missing", code: "file_not_found" } });
		await expect(ok).resolves.toBe("list");
		await expect(failed).rejects.toThrow("[file_not_found] missing");
	});

	it("holds calls made before the link is up and sends them after hello", async () => {
		const { transport, last } = setup();
		transport.start();
		const early = transport.invoke<number>("x:y");
		await settle();
		expect(last().framesOf("inv")).toEqual([]);
		last().serve(HELLO());
		expect(last().framesOf("inv")).toHaveLength(1);
		last().serve({ t: "res", id: 1, ok: true, v: 7 });
		await expect(early).resolves.toBe(7);
	});

	it("fails a held call when the host stays unreachable", async () => {
		const { transport, clock } = setup({ connectWaitMs: 5000 });
		transport.start();
		const early = transport.invoke("x:y");
		clock.advance(5001);
		await expect(early).rejects.toThrow("not reachable");
	});

	it("rejects a request over the frame limit without sending it", async () => {
		const { transport, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		await expect(transport.invoke("big", "x".repeat(1_100_000))).rejects.toThrow("1 MB");
		expect(last().framesOf("inv")).toEqual([]);
	});

	it("delivers events to channel listeners and acks the last seq once", async () => {
		const { transport, last, clock } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const seen: unknown[] = [];
		const off = transport.on("tab:status", data => seen.push(data));
		last().serve({ t: "evt", seq: 1, ch: "tab:status", d: { a: 1 } });
		last().serve({ t: "evt", seq: 2, ch: "tab:status", d: { a: 2 } });
		last().serve({ t: "evt", seq: 3, ch: "other", d: null });
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
		expect(last().framesOf("ack")).toEqual([]);
		clock.advance(200);
		expect(last().framesOf("ack")).toEqual([{ t: "ack", seq: 3 }]);
		off();
		last().serve({ t: "evt", seq: 4, ch: "tab:status", d: { a: 3 } });
		expect(seen).toHaveLength(2);
	});

	it("sends fire-and-forget frames only while open, and answers a ping", async () => {
		const { transport, last } = setup();
		transport.send("early");
		transport.start();
		await settle();
		last().serve(HELLO());
		transport.send("runtime:report", { a: 1 });
		last().serve({ t: "ping" });
		expect(last().framesOf("snd")).toEqual([{ t: "snd", ch: "runtime:report", a: [{ a: 1 }] }]);
		expect(last().framesOf("pong")).toHaveLength(1);
		transport.setPresence(false);
		expect(last().framesOf("presence").at(-1)).toEqual({ t: "presence", visible: false });
	});

	it("reconnects with a doubling backoff capped at 8 s, and resets it after a hello", async () => {
		const { transport, clock, sockets, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		last().drop();
		expect(transport.state).toBe("reconnecting");
		const delays: number[] = [];
		for (const expected of [500, 1000, 2000, 4000, 8000, 8000]) {
			const before = sockets.length;
			clock.advance(expected - 1);
			await settle();
			expect(sockets.length).toBe(before);
			clock.advance(1);
			await settle();
			expect(sockets.length).toBe(before + 1);
			delays.push(expected);
			last().drop();
		}
		expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
		clock.advance(8000);
		await settle();
		last().serve(HELLO(true));
		last().drop();
		const count = sockets.length;
		clock.advance(500);
		await settle();
		expect(sockets.length).toBe(count + 1);
	});

	it("asks for a resync only on a reconnect that lost events", async () => {
		const { transport, clock, last, log } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		expect(log.resync).toBe(0);
		last().drop();
		clock.advance(600);
		await settle();
		last().serve(HELLO(false));
		expect(log.resync).toBe(1);
		last().drop();
		clock.advance(600);
		await settle();
		last().serve(HELLO(true));
		expect(log.resync).toBe(1);
	});

	it("offers the last connection's id on a reconnect, and resyncs a resumed link that failed a call", async () => {
		const { transport, clock, last, log } = setup();
		transport.start();
		await settle();
		expect(last().protocols).toEqual(["ompdesk.v1", "ticket.t1"]);
		last().serve(HELLO());
		last().drop();
		clock.advance(600);
		await settle();
		expect(last().protocols).toEqual(["ompdesk.v1", "ticket.t2", "resume.c1"]);
		last().serve(HELLO(true));
		expect(log.resync).toBe(0);
		// A call in flight when the link drops is lost: the host's resume cannot answer it.
		const call = transport.invoke("tabs:list").catch((error: Error) => error.message);
		last().drop();
		expect(await call).toBe("The link to the computer dropped");
		clock.advance(600);
		await settle();
		last().serve(HELLO(true));
		expect(log.resync).toBe(1);
		// The next clean resume needs nothing again.
		last().drop();
		clock.advance(600);
		await settle();
		last().serve(HELLO(true));
		expect(log.resync).toBe(1);
	});

	it("fails calls in flight when the link drops, and sends later ones after the reconnect", async () => {
		const { transport, clock, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const inflight = transport.invoke("a:b");
		last().drop();
		await expect(inflight).rejects.toThrow("dropped");
		const later = transport.invoke<string>("c:d");
		clock.advance(600);
		await settle();
		last().serve(HELLO());
		expect(last().framesOf("inv")).toHaveLength(1);
		last().serve({ t: "res", id: 2, ok: true, v: "ok" });
		await expect(later).resolves.toBe("ok");
	});

	it("wake() retries at once instead of waiting out the backoff", async () => {
		const { transport, clock, sockets, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		last().drop();
		clock.advance(100);
		const before = sockets.length;
		transport.wake();
		await settle();
		expect(sockets.length).toBe(before + 1);
	});

	it("wake() on an open link probes it and drops it when nothing answers", async () => {
		const { transport, clock, sockets, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const first = last();
		transport.wake();
		expect(first.framesOf("ping")).toHaveLength(1);
		clock.advance(5001);
		expect(first.closedWith).toBe(4000);
		expect(transport.state).toBe("reconnecting");
		clock.advance(600);
		await settle();
		expect(sockets.length).toBe(2);
	});

	it("wake() on a link that answers keeps it", async () => {
		const { transport, clock, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const first = last();
		clock.advance(1);
		transport.wake();
		last().serve({ t: "pong" });
		clock.advance(5001);
		expect(first.closedWith).toBeNull();
		expect(transport.state).toBe("open");
	});

	it("drops the link only after three silent heartbeat intervals", async () => {
		const { transport, clock, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const socket = last();
		clock.advance(20_000);
		clock.advance(20_000);
		expect(socket.closedWith).toBeNull();
		expect(socket.framesOf("ping").length).toBeGreaterThanOrEqual(2);
		clock.advance(20_000);
		expect(socket.closedWith).toBe(4000);
		expect(transport.state).toBe("reconnecting");
	});

	it("does not count a missed beat when anything arrived in between", async () => {
		const { transport, clock, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const socket = last();
		for (let i = 0; i < 6; i++) {
			clock.advance(20_000);
			socket.serve({ t: "ping" });
		}
		expect(socket.closedWith).toBeNull();
	});

	it("ignores a heartbeat that fires late because the phone slept", async () => {
		const { transport, clock, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		const socket = last();
		clock.advance(20_000);
		clock.advance(20_000);
		// The device slept for ten minutes: one late tick, no misses charged for it.
		clock.now += 600_000;
		clock.advance(20_000);
		expect(socket.closedWith).toBeNull();
	});

	it("treats a 4401 close as an unpaired device and stops retrying", async () => {
		const { transport, clock, sockets, last, log } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		last().drop(4401);
		expect(transport.state).toBe("unpaired");
		expect(log.unpaired).toBe(1);
		clock.advance(60_000);
		await settle();
		expect(sockets).toHaveLength(1);
		await expect(transport.invoke("a:b")).rejects.toThrow("not paired");
	});

	it("treats a refused ticket as an unpaired device", async () => {
		const { transport, sockets, log, states } = setup({
			fetchTicket: async () => {
				throw new UnpairedError();
			},
		});
		transport.start();
		await settle();
		expect(sockets).toHaveLength(0);
		expect(states.at(-1)).toBe("unpaired");
		expect(log.unpaired).toBe(1);
	});

	it("retries when the ticket request itself fails", async () => {
		let attempts = 0;
		const { transport, clock, sockets } = setup({
			fetchTicket: async () => {
				attempts++;
				if (attempts === 1) throw new Error("offline");
				return "t";
			},
		});
		transport.start();
		await settle();
		expect(sockets).toHaveLength(0);
		clock.advance(600);
		await settle();
		expect(sockets).toHaveLength(1);
	});

	it("reports an outdated page when the host's minimum client is newer", async () => {
		const { transport, last, log, clock, sockets } = setup();
		transport.start();
		await settle();
		last().serve(HELLO(false, 2));
		expect(transport.state).toBe("outdated");
		expect(log.outdated).toBe(1);
		clock.advance(60_000);
		await settle();
		expect(sockets).toHaveLength(1);
	});

	it("closes a socket that never says hello and tries again", async () => {
		const { transport, clock, sockets } = setup({ helloMs: 3000 });
		transport.start();
		await settle();
		clock.advance(3001);
		expect(sockets[0]?.closedWith).toBe(4001);
		clock.advance(600);
		await settle();
		expect(sockets).toHaveLength(2);
	});

	it("ignores frames that are not JSON frames", async () => {
		const { transport, last } = setup();
		transport.start();
		await settle();
		last().onmessage?.({ data: "not json" });
		last().onmessage?.({ data: 42 });
		last().onmessage?.({ data: JSON.stringify({ nope: true }) });
		last().serve(HELLO());
		expect(transport.state).toBe("open");
	});

	it("close() ends it for good", async () => {
		const { transport, clock, sockets, last } = setup();
		transport.start();
		await settle();
		last().serve(HELLO());
		transport.close();
		expect(transport.state).toBe("closed");
		clock.advance(60_000);
		await settle();
		expect(sockets).toHaveLength(1);
		await expect(transport.invoke("a:b")).rejects.toThrow("closed");
	});
});
