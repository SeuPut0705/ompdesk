/**
 * The event stream behind `subscribe`: a ring of the latest events, one cursor per subscriber. A subscriber that
 * cannot keep up (its socket is full) is told exactly how many events it lost and its subscription ends: nothing is
 * skipped silently. Sessions hidden from agents never appear (the backend's `views`/`view` leave them out).
 */

import type { ControlEvent, EventFrame, SessionState } from "../../../resources/cli/protocol";
import type { ControlBackend } from "./backend";

export interface EventSink {
	/** Writes one JSON line; false means the sink is full and `onDrain` says when it may be written to again. */
	write(line: string): boolean;
	/** Calls `callback` once, when a sink that answered false can take more. */
	onDrain(callback: () => void): void;
}

interface Entry {
	seq: number;
	event: ControlEvent;
}

interface Subscription {
	callerId: string;
	sub: number;
	sink: EventSink;
	cursor: number;
	paused: boolean;
	ended: boolean;
}

export interface EventHubOptions {
	capacity?: number;
	pollMs?: number;
}

export class EventHub {
	readonly #backend: ControlBackend;
	readonly #capacity: number;
	readonly #pollMs: number;
	readonly #ring: Entry[] = [];
	readonly #subscriptions = new Set<Subscription>();
	readonly #known = new Map<string, SessionState>();
	#nextSeq = 1;
	#detach: (() => void) | undefined;

	constructor(backend: ControlBackend, { capacity = 1024, pollMs = 1000 }: EventHubOptions = {}) {
		this.#backend = backend;
		this.#capacity = capacity;
		this.#pollMs = pollMs;
	}

	/** Starts live: the subscriber sees events from now on, never earlier ones. Returns the unsubscribe. */
	subscribe(callerId: string, sink: EventSink, sub = 0): () => void {
		if (this.#subscriptions.size === 0) this.#attach();
		const subscription: Subscription = {
			callerId,
			sub,
			sink,
			cursor: this.#nextSeq,
			paused: false,
			ended: false,
		};
		this.#subscriptions.add(subscription);
		return () => this.#drop(subscription);
	}

	#drop(subscription: Subscription): void {
		subscription.ended = true;
		this.#subscriptions.delete(subscription);
		if (this.#subscriptions.size === 0) this.#detach?.();
	}

	/** Sources run only while somebody listens: no activity listener and no poll timer for an idle hub. */
	#attach(): void {
		this.#known.clear();
		for (const view of this.#backend.views()) this.#known.set(view.session, view.state);
		const stopActivity = this.#backend.observe(activity => {
			switch (activity.type) {
				case "released":
					if (this.#known.delete(activity.tabId))
						this.#publish({ type: "session_closed", session: activity.tabId });
					return;
				case "ask": {
					this.#syncStates();
					const view = this.#backend.view(activity.tabId);
					if (view === null) return;
					this.#publish({
						type: "ask",
						session: activity.tabId,
						title: view.title,
						requestId: activity.requestId,
						text: activity.text,
					});
					return;
				}
				case "idle": {
					this.#syncStates();
					const view = this.#backend.view(activity.tabId);
					if (view === null) return;
					this.#publish({
						type: "turn_finished",
						session: activity.tabId,
						title: view.title,
						stopReason: activity.outcome?.stopReason ?? "stop",
					});
					return;
				}
				default:
					this.#syncStates();
			}
		});
		const stopMail = this.#backend.onOutsideMail((to, text) => this.#publish({ type: "report", to, text }));
		const timer = setInterval(() => this.#syncStates(), this.#pollMs);
		timer.unref();
		this.#detach = () => {
			stopActivity();
			stopMail();
			clearInterval(timer);
			this.#detach = undefined;
		};
	}

	#syncStates(): void {
		const seen = new Set<string>();
		for (const view of this.#backend.views()) {
			seen.add(view.session);
			const previous = this.#known.get(view.session) ?? null;
			if (previous === view.state) continue;
			this.#known.set(view.session, view.state);
			this.#publish({
				type: "session_state",
				session: view.session,
				title: view.title,
				state: view.state,
				previous,
			});
		}
		// A session that left `views` without a release was hidden: it vanishes without a word.
		for (const session of [...this.#known.keys()]) if (!seen.has(session)) this.#known.delete(session);
	}

	#publish(event: ControlEvent): void {
		this.#ring.push({ seq: this.#nextSeq++, event });
		if (this.#ring.length > this.#capacity) this.#ring.splice(0, this.#ring.length - this.#capacity);
		for (const subscription of [...this.#subscriptions]) this.#pump(subscription);
	}

	#pump(subscription: Subscription): void {
		while (!subscription.ended && !subscription.paused) {
			const oldest = this.#ring[0]?.seq ?? this.#nextSeq;
			if (subscription.cursor < oldest) {
				const lost = oldest - subscription.cursor;
				const frame: EventFrame = {
					sub: subscription.sub,
					error: {
						code: "events_lost",
						message: `${lost} event${lost === 1 ? "" : "s"} dropped: the reader fell behind. Subscribe again and resync with \`ompdesk sessions\` (or \`state\` per session).`,
						lost,
					},
				};
				subscription.sink.write(`${JSON.stringify(frame)}\n`);
				this.#drop(subscription);
				return;
			}
			if (subscription.cursor >= this.#nextSeq) return;
			const entry = this.#ring[subscription.cursor - oldest];
			subscription.cursor++;
			if (entry === undefined) return;
			if (entry.event.type === "report" && entry.event.to !== subscription.callerId) continue;
			const frame: EventFrame = { sub: subscription.sub, seq: entry.seq, event: entry.event };
			if (subscription.sink.write(`${JSON.stringify(frame)}\n`)) continue;
			subscription.paused = true;
			subscription.sink.onDrain(() => {
				subscription.paused = false;
				this.#pump(subscription);
			});
		}
	}
}
