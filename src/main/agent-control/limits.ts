/**
 * What stops an orchestrating agent from running away (contract constants in `src/shared/agent-control.ts`).
 * Everything here is main-owned state keyed by tab id: a message's provenance is never read from its text or from
 * tool arguments, so a transcript, a tool result or another session's reply cannot forge or reset it.
 *
 * - Budgets: sessions opened and messages sent, per turn of the sending session and per rolling hour.
 * - Relay guard: a chain A → B → C … started by agent messages is cut after `MAX_RELAY_HOPS` hops, a pair of
 *   sessions exchanges at most `MAX_PAIR_MESSAGES_PER_MINUTE` messages a minute, and a session never writes to itself.
 */
import {
	MAX_AGENT_AUTOPILOT_RUNS,
	MAX_MESSAGES_PER_HOUR,
	MAX_MESSAGES_PER_TURN,
	MAX_OPENS_PER_HOUR,
	MAX_OPENS_PER_TURN,
	MAX_PAIR_MESSAGES_PER_MINUTE,
	MAX_RELAY_HOPS,
} from "../../shared/agent-control";

/** Prefix of a run key that has no tab yet. */
export const PENDING_RUN = "pending:";

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
/** A chain's hop count stops counting for a session this long after the message that set it. */
export const RELAY_MEMORY_MS = 10 * MINUTE_MS;

export class LimitError extends Error {}

function within(stamps: number[], now: number, windowMs: number): number[] {
	return stamps.filter(at => now - at < windowMs);
}

export class AgentLimits {
	readonly #now: () => number;
	/** caller → per-hour stamps of opens / messages. */
	readonly #hourOpens = new Map<string, number[]>();
	readonly #hourMessages = new Map<string, number[]>();
	/** caller → `${turn}` and what it spent in that turn. */
	readonly #turns = new Map<string, { turn: number; opens: number; messages: number }>();
	/** Unordered pair key → stamps of the last minute. */
	readonly #pairs = new Map<string, number[]>();
	/** Session → the hops of the agent-message chain that last reached it. */
	readonly #lineage = new Map<string, { hops: number; at: number }>();
	/** Run tabs of the Autopilot runs agents started, and reservations (`PENDING_RUN`) while a start is under way. */
	readonly #runs = new Set<string>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	#turnOf(caller: string, turn: number): { turn: number; opens: number; messages: number } {
		const current = this.#turns.get(caller);
		if (current && current.turn === turn) return current;
		const fresh = { turn, opens: 0, messages: 0 };
		this.#turns.set(caller, fresh);
		return fresh;
	}

	/** Reserve `count` opens, or throw. Nothing is spent when it throws. */
	reserveOpens(caller: string, turn: number, count: number): void {
		const now = this.#now();
		const spent = this.#turnOf(caller, turn);
		if (spent.opens + count > MAX_OPENS_PER_TURN)
			throw new LimitError(
				`This turn you already opened ${spent.opens} session(s); at most ${MAX_OPENS_PER_TURN} per turn. Collect their results first.`,
			);
		const hour = within(this.#hourOpens.get(caller) ?? [], now, HOUR_MS);
		if (hour.length + count > MAX_OPENS_PER_HOUR)
			throw new LimitError(
				`You opened ${hour.length} sessions in the last hour; at most ${MAX_OPENS_PER_HOUR} per hour.`,
			);
		spent.opens += count;
		for (let i = 0; i < count; i++) hour.push(now);
		this.#hourOpens.set(caller, hour);
	}

	/** Give back reservations of opens that failed before a session existed. */
	refundOpens(caller: string, turn: number, count: number): void {
		const spent = this.#turns.get(caller);
		if (spent && spent.turn === turn) spent.opens = Math.max(0, spent.opens - count);
		const hour = this.#hourOpens.get(caller) ?? [];
		hour.splice(Math.max(0, hour.length - count), count);
	}

	/**
	 * Reserve one message from `from` to `to`, or throw. The relay hop count of the chain this extends is the one
	 * main recorded for `from`; the receiver inherits it plus one.
	 */
	reserveMessage(from: string, to: string, turn: number): void {
		if (from === to) throw new LimitError("A session cannot message itself.");
		const now = this.#now();
		const spent = this.#turnOf(from, turn);
		if (spent.messages >= MAX_MESSAGES_PER_TURN)
			throw new LimitError(
				`This turn you already sent ${spent.messages} messages; at most ${MAX_MESSAGES_PER_TURN} per turn.`,
			);
		const hour = within(this.#hourMessages.get(from) ?? [], now, HOUR_MS);
		if (hour.length >= MAX_MESSAGES_PER_HOUR)
			throw new LimitError(
				`You sent ${hour.length} messages in the last hour; at most ${MAX_MESSAGES_PER_HOUR} per hour.`,
			);
		const key = from < to ? `${from}|${to}` : `${to}|${from}`;
		const pair = within(this.#pairs.get(key) ?? [], now, MINUTE_MS);
		if (pair.length >= MAX_PAIR_MESSAGES_PER_MINUTE)
			throw new LimitError(
				`These two sessions already exchanged ${pair.length} messages in the last minute (at most ${MAX_PAIR_MESSAGES_PER_MINUTE}). Wait, or stop the back-and-forth.`,
			);
		const mine = this.#lineage.get(from);
		const hops = mine && now - mine.at < RELAY_MEMORY_MS ? mine.hops : 0;
		if (hops + 1 > MAX_RELAY_HOPS)
			throw new LimitError(
				`This message would be hop ${hops + 1} of a chain of agent messages (the limit is ${MAX_RELAY_HOPS}). Report to the user instead of passing it on.`,
			);
		spent.messages += 1;
		hour.push(now);
		this.#hourMessages.set(from, hour);
		pair.push(now);
		this.#pairs.set(key, pair);
		this.#lineage.set(to, { hops: hops + 1, at: now });
	}

	/** The tabs of the Autopilot runs agents started and that may still be live (a reservation counts until it settles). */
	runTabs(): string[] {
		return [...this.#runs].filter(key => !key.startsWith(PENDING_RUN));
	}

	/**
	 * Reserve one agent-started Autopilot run under `key`, or throw. `ended` are run tabs whose run is over: they stop
	 * counting. The count is global (every session of the app), not per caller.
	 */
	reserveRun(key: string, ended: ReadonlySet<string>): void {
		for (const tab of ended) this.#runs.delete(tab);
		if (this.#runs.size >= MAX_AGENT_AUTOPILOT_RUNS)
			throw new LimitError(
				`${this.#runs.size} Autopilot runs started by agents are still live (the limit is ${MAX_AGENT_AUTOPILOT_RUNS}). Stop one with ompdesk_autopilot {"action":"stop"} or ask the user.`,
			);
		this.#runs.add(key);
	}

	/** The reserved run now has its tab. */
	settleRun(key: string, tab: string): void {
		if (this.#runs.delete(key)) this.#runs.add(tab);
	}

	/** Give back a reservation whose start failed. */
	dropRun(key: string): void {
		this.#runs.delete(key);
	}

	/** A closed session leaves no state behind. */
	forget(tab: string): void {
		this.#lineage.delete(tab);
		this.#turns.delete(tab);
		this.#hourOpens.delete(tab);
		this.#hourMessages.delete(tab);
		this.#runs.delete(tab);
		for (const key of this.#pairs.keys()) if (key.split("|").includes(tab)) this.#pairs.delete(key);
	}
}
