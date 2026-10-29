import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventFrame, SessionState } from "../../../resources/cli/protocol";
import type { TabActivity } from "../sidecar-pool";
import type { ControlBackend, SessionView } from "./backend";
import { EventHub, type EventSink } from "./events";

class FakeBackend implements ControlBackend {
	readonly sessions = new Map<string, SessionView>();
	readonly listeners = new Set<(activity: TabActivity) => void>();
	readonly mailListeners = new Set<(callerId: string, text: string) => void>();

	add(session: string, state: SessionState, title = `title of ${session}`): void {
		this.sessions.set(session, { session, title, state });
	}

	setState(session: string, state: SessionState): void {
		const view = this.sessions.get(session);
		if (view) this.sessions.set(session, { ...view, state });
	}

	fire(activity: TabActivity): void {
		for (const listener of [...this.listeners]) listener(activity);
	}

	mail(callerId: string, text: string): void {
		for (const listener of [...this.mailListeners]) listener(callerId, text);
	}

	run(): never {
		throw new Error("not used");
	}

	resolve(): never {
		throw new Error("not used");
	}

	view(session: string): SessionView | null {
		return this.sessions.get(session) ?? null;
	}

	views(): SessionView[] {
		return [...this.sessions.values()];
	}

	observe(listener: (activity: TabActivity) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	release(): void {}

	onOutsideMail(listener: (callerId: string, text: string) => void): () => void {
		this.mailListeners.add(listener);
		return () => this.mailListeners.delete(listener);
	}
}

class RecordingSink implements EventSink {
	readonly frames: EventFrame[] = [];
	accepting = true;
	#drained: (() => void) | undefined;

	write(line: string): boolean {
		expect(line.endsWith("\n")).toBe(true);
		this.frames.push(JSON.parse(line) as EventFrame);
		return this.accepting;
	}

	onDrain(callback: () => void): void {
		this.#drained = callback;
	}

	drain(): void {
		this.accepting = true;
		const callback = this.#drained;
		this.#drained = undefined;
		callback?.();
	}
}

describe("EventHub", () => {
	afterEach(() => vi.useRealTimers());

	it("orders events with increasing seq and tags them with the subscription", () => {
		const backend = new FakeBackend();
		backend.add("s1", "idle");
		const hub = new EventHub(backend);
		const sink = new RecordingSink();
		const unsubscribe = hub.subscribe("outside:cli", sink, 7);

		backend.setState("s1", "working");
		backend.fire({ type: "busy", tabId: "s1" });
		backend.fire({ type: "ask", tabId: "s1", requestId: "q1", text: "Proceed?" });
		backend.setState("s1", "idle");
		backend.fire({ type: "idle", tabId: "s1", outcome: { stopReason: "error" } });
		backend.add("s2", "working");
		backend.fire({ type: "step", tabId: "s2" });
		backend.sessions.delete("s1");
		backend.fire({ type: "released", tabId: "s1" });

		expect(sink.frames.every(frame => frame.sub === 7)).toBe(true);
		const events = sink.frames.map(frame => {
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

		unsubscribe();
		expect(backend.listeners.size).toBe(0);
		expect(backend.mailListeners.size).toBe(0);
	});

	it("reports a turn end without an outcome as a normal stop", () => {
		const backend = new FakeBackend();
		backend.add("s1", "idle");
		const hub = new EventHub(backend);
		const sink = new RecordingSink();
		hub.subscribe("outside:cli", sink);
		backend.fire({ type: "idle", tabId: "s1", outcome: undefined });
		expect(sink.frames).toMatchObject([{ event: { type: "turn_finished", stopReason: "stop" } }]);
	});

	it("starts live: a subscriber sees nothing from before it subscribed", () => {
		const backend = new FakeBackend();
		backend.add("s1", "idle");
		const hub = new EventHub(backend);
		const first = new RecordingSink();
		hub.subscribe("outside:cli", first);
		backend.mail("outside:cli", "early");
		const late = new RecordingSink();
		hub.subscribe("outside:cli", late);
		backend.mail("outside:cli", "later");
		expect(first.frames).toHaveLength(2);
		expect(late.frames).toMatchObject([{ seq: 2, event: { type: "report", text: "later" } }]);
	});

	it("delivers a report only to the caller it is addressed to", () => {
		const backend = new FakeBackend();
		const hub = new EventHub(backend);
		const mine = new RecordingSink();
		const other = new RecordingSink();
		hub.subscribe("outside:mine", mine);
		hub.subscribe("outside:other", other);
		backend.mail("outside:mine", "done: all green");
		expect(mine.frames).toMatchObject([{ event: { type: "report", to: "outside:mine", text: "done: all green" } }]);
		expect(other.frames).toEqual([]);
	});

	it("never emits a session hidden from agents", () => {
		const backend = new FakeBackend();
		backend.add("shown", "idle");
		const hub = new EventHub(backend);
		const sink = new RecordingSink();
		hub.subscribe("outside:cli", sink);

		backend.fire({ type: "ask", tabId: "hidden", requestId: "q", text: "secret?" });
		backend.fire({ type: "idle", tabId: "hidden", outcome: { stopReason: "stop" } });
		backend.fire({ type: "released", tabId: "hidden" });
		expect(sink.frames).toEqual([]);
	});

	it("sees a state change that raised no activity on its poll, and polls only while somebody listens", () => {
		vi.useFakeTimers();
		const backend = new FakeBackend();
		backend.add("s1", "working");
		const hub = new EventHub(backend, { pollMs: 1_000 });
		expect(vi.getTimerCount()).toBe(0);
		const sink = new RecordingSink();
		const unsubscribe = hub.subscribe("outside:cli", sink);
		backend.setState("s1", "blocked");
		vi.advanceTimersByTime(1_000);
		expect(sink.frames).toMatchObject([{ event: { type: "session_state", state: "blocked", previous: "working" } }]);
		unsubscribe();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("tells a reader that fell behind how many events it lost, once, and ends its subscription", () => {
		const backend = new FakeBackend();
		const hub = new EventHub(backend, { capacity: 4 });
		const slow = new RecordingSink();
		slow.accepting = false;
		const keeping = new RecordingSink();
		hub.subscribe("outside:cli", slow, 3);
		hub.subscribe("outside:cli", keeping, 4);

		for (let n = 1; n <= 10; n++) backend.mail("outside:cli", `report ${n}`);
		expect(slow.frames).toHaveLength(1);
		expect(keeping.frames).toHaveLength(10);

		slow.drain();
		expect(slow.frames).toHaveLength(2);
		expect(slow.frames[1]).toEqual({
			sub: 3,
			error: {
				code: "events_lost",
				message: expect.stringMatching(/5 events.*Subscribe again and resync/),
				lost: 5,
			},
		});

		backend.mail("outside:cli", "after");
		slow.drain();
		expect(slow.frames).toHaveLength(2);
		expect(keeping.frames).toHaveLength(11);
	});

	it("lets a reader that drains in time carry on without loss", () => {
		const backend = new FakeBackend();
		const hub = new EventHub(backend, { capacity: 4 });
		const sink = new RecordingSink();
		sink.accepting = false;
		hub.subscribe("outside:cli", sink);
		backend.mail("outside:cli", "1");
		backend.mail("outside:cli", "2");
		backend.mail("outside:cli", "3");
		sink.drain();
		expect(sink.frames.map(frame => ("seq" in frame ? frame.seq : "error"))).toEqual([1, 2, 3]);
	});
});
