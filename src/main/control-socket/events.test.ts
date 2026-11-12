import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventFrame } from "../../shared/control-protocol";
import { stopCore } from "../core/process";
import { type Connected, ControlRig, TestBackend } from "./control-test-rig";
import type { ControlTuning } from "./server";

// The event stream is the core's (native/ompdesk/crates/core/src/control/events.rs): every case subscribes over a real
// connection and hears what main's backend does. Each connection is its own outside caller, named by its hello, so a
// report reaches the subscriptions of the connection it is addressed to.

/**
 * An ask's text of 1 MiB: one such frame passes the connection's high-water mark by itself (the subscription pauses
 * on it), and no OS buffer holds it, so a reader that stopped reading keeps its connection backed up.
 */
const BIG = "x".repeat(1024 * 1024);

describe("control events", () => {
	const rig = new ControlRig();
	let backend: TestBackend;

	beforeEach(() => {
		backend = new TestBackend();
	});
	afterEach(() => rig.cleanup());
	afterAll(() => stopCore());

	const serve = (tuning: ControlTuning = {}) => rig.serve(backend, { tuning });

	/** A connection subscribed as request `sub`, once main forwards activity and reports to the core. */
	async function subscribe(path: string, sub: number, connected?: Connected): Promise<Connected> {
		const at = connected ?? (await rig.connect(path));
		expect(await at.client.call({ id: sub, method: "subscribe" })).toEqual({ id: sub, ok: true, result: { sub } });
		await backend.watched(true, { mail: true });
		return at;
	}

	/**
	 * What subscription `sub` heard before a report sent now: the stream is in main's order, so the report arriving
	 * shows nothing else was on its way.
	 */
	async function heardBefore({ client, caller }: Connected, sub: number): Promise<EventFrame[]> {
		const marker = `marker for ${sub}`;
		const isMarker = (frame: EventFrame) =>
			"event" in frame && frame.event.type === "report" && frame.event.text === marker;
		backend.mail(caller.id, marker);
		await client.until(() => client.frames(sub).some(isMarker), `the marker report of ${sub}`);
		const frames = client.frames(sub);
		return frames.slice(0, frames.findIndex(isMarker));
	}

	it("orders events with increasing seq and tags them with the subscription", async () => {
		const path = await serve();
		backend.add("s1", "idle");
		const connected = await subscribe(path, 7);

		backend.setState("s1", "working");
		backend.fire({ type: "busy", tabId: "s1" });
		backend.fire({ type: "ask", tabId: "s1", requestId: "q1", text: "Proceed?" });
		backend.setState("s1", "idle");
		backend.fire({ type: "idle", tabId: "s1", outcome: { stopReason: "error" } });
		backend.add("s2", "working");
		backend.fire({ type: "step", tabId: "s2" });
		backend.sessions.delete("s1");
		backend.fire({ type: "released", tabId: "s1" });

		const frames = await heardBefore(connected, 7);
		expect(connected.client.lines.filter(line => "sub" in line).every(frame => frame.sub === 7)).toBe(true);
		const events = frames.map(frame => {
			if (!("event" in frame)) throw new Error("unexpected error frame");
			return { seq: frame.seq, event: frame.event };
		});
		expect(events.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(events.map(entry => entry.event)).toEqual([
			{ type: "session_state", session: "s1", title: "title of s1", state: "working", previous: "idle" },
			{ type: "ask", session: "s1", title: "title of s1", requestId: "q1", text: "Proceed?" },
			{ type: "session_state", session: "s1", title: "title of s1", state: "idle", previous: "working" },
			{ type: "turn_finished", session: "s1", title: "title of s1", stopReason: "error" },
			{ type: "session_state", session: "s2", title: "title of s2", state: "working", previous: null },
			{ type: "session_closed", session: "s1" },
		]);

		// Its connection closing ends the subscription: main no longer forwards anything.
		connected.client.close();
		await connected.client.closed;
		await backend.watched(false, { mail: true });
		expect(backend.listeners.size).toBe(0);
		expect(backend.mailListeners.size).toBe(0);
	});

	it("reports a turn end without an outcome as a normal stop", async () => {
		const path = await serve();
		backend.add("s1", "idle");
		const connected = await subscribe(path, 1);
		backend.fire({ type: "idle", tabId: "s1", outcome: undefined });
		expect(await heardBefore(connected, 1)).toMatchObject([{ event: { type: "turn_finished", stopReason: "stop" } }]);
	});

	it("starts live: a subscriber sees nothing from before it subscribed", async () => {
		const path = await serve();
		backend.add("s1", "idle");
		const connected = await subscribe(path, 2);
		const { client, caller } = connected;
		backend.mail(caller.id, "early");
		await client.framesOf(2, 1);
		// A second subscription of the same connection (its caller), after the first report went out.
		await subscribe(path, 3, connected);
		backend.mail(caller.id, "later");
		const late = await client.framesOf(3, 1);
		expect(late).toMatchObject([{ seq: 2, event: { type: "report", text: "later" } }]);
		expect(await client.framesOf(2, 2)).toHaveLength(2);
	});

	it("delivers a report only to the caller it is addressed to", async () => {
		const path = await serve();
		const mine = await subscribe(path, 1);
		const other = await subscribe(path, 1);
		expect(other.caller.id).not.toBe(mine.caller.id);
		backend.mail(mine.caller.id, "done: all green");
		expect(await mine.client.framesOf(1, 1)).toMatchObject([
			{ event: { type: "report", to: mine.caller.id, text: "done: all green" } },
		]);
		expect(await heardBefore(other, 1)).toEqual([]);
	});

	it("never emits a session hidden from agents", async () => {
		const path = await serve();
		backend.add("shown", "idle");
		const connected = await subscribe(path, 1);

		backend.fire({ type: "ask", tabId: "hidden", requestId: "q", text: "secret?" });
		backend.fire({ type: "idle", tabId: "hidden", outcome: { stopReason: "stop" } });
		backend.fire({ type: "released", tabId: "hidden" });
		expect(await heardBefore(connected, 1)).toEqual([]);
	});

	it("sees a state change that raised no activity on its poll, and has main forward only while somebody listens", async () => {
		const path = await serve({ eventPollMs: 20 });
		backend.add("s1", "working");
		expect(backend.listeners.size).toBe(0);
		const { client } = await subscribe(path, 1);
		backend.setState("s1", "blocked");
		expect(await client.framesOf(1, 1)).toMatchObject([
			{ event: { type: "session_state", state: "blocked", previous: "working" } },
		]);
		client.close();
		await client.closed;
		await backend.watched(false, { mail: true });
	});

	it("tells a reader that fell behind how many events it lost, once, and ends its subscription", async () => {
		const path = await serve({ eventCapacity: 4 });
		backend.add("s1", "idle");
		const slow = await subscribe(path, 3);
		const keeping = await subscribe(path, 4);
		slow.client.pause();

		// Each ask goes out once the keeping reader took the one before: it is never more than one behind.
		for (let n = 1; n <= 10; n++) {
			backend.fire({ type: "ask", tabId: "s1", requestId: `q${n}`, text: BIG });
			await keeping.client.framesOf(4, n);
		}
		slow.client.resume();
		await slow.client.until(() => slow.client.frames(3).some(frame => "error" in frame), "the events_lost frame");
		const frames = slow.client.frames(3);
		expect(frames[0]).toMatchObject({ sub: 3, seq: 1, event: { type: "ask", requestId: "q1" } });
		const loss = frames.at(-1);
		if (!loss || !("error" in loss)) throw new Error("no events_lost frame");
		const delivered = frames.slice(0, -1).map(frame => {
			if (!("seq" in frame)) throw new Error("an error before the last frame");
			return frame.seq;
		});
		expect(delivered).toEqual(Array.from({ length: delivered.length }, (_, n) => n + 1));
		// OS buffers can take more than one frame before the paused reader blocks. The ring's oldest is 7,
		// so its exact loss is 6 minus the last delivered sequence, not a fixed OS-dependent count.
		expect(loss.error.code).toBe("events_lost");
		expect(loss.error.lost).toBe(6 - delivered.length);
		expect(loss.error.lost).toBeGreaterThan(0);
		expect(loss.error.message).toMatch(/Subscribe again and resync/);

		backend.fire({ type: "ask", tabId: "s1", requestId: "after", text: "after" });
		expect(await keeping.client.framesOf(4, 11)).toHaveLength(11);
		// A request's answer on the slow connection comes after anything already written to it.
		expect(await slow.client.call({ method: "tool", tool: "ompdesk_sessions" })).toMatchObject({ ok: true });
		expect(slow.client.frames(3)).toHaveLength(frames.length);
	});

	it("lets a reader that drains in time carry on without loss", async () => {
		const path = await serve({ eventCapacity: 4 });
		backend.add("s1", "idle");
		const reader = await subscribe(path, 1);
		const witness = await subscribe(path, 2);
		reader.client.pause();
		for (const n of [1, 2, 3]) backend.fire({ type: "ask", tabId: "s1", requestId: `q${n}`, text: BIG });
		// All three were published while the reader was backed up.
		await witness.client.framesOf(2, 3);
		reader.client.resume();
		await reader.client.framesOf(1, 3);
		expect(await reader.client.call({ method: "tool", tool: "ompdesk_sessions" })).toMatchObject({ ok: true });
		expect(reader.client.frames(1).map(frame => ("seq" in frame ? frame.seq : "error"))).toEqual([1, 2, 3]);
	});
});
