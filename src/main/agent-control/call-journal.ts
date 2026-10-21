/**
 * Control-tool calls that change something, recorded by the call's own identity so a call made again after a relaunch
 * runs at most once. A paired host re-sends every host tool call its omp still waits on to a device that relaunched
 * (`HostTab.hostCalls`, remote/host-services.ts), and so does nothing else: a call this computer had already carried
 * out before it died (a session opened, a schedule saved) would otherwise run a second time.
 *
 * Two steps, each written before what it records can be lost: `begin` before the call's effect (a crash after the
 * effect leaves a pending record, never nothing), `finish` with the result once it is known. A call made again whose
 * record is finished gets that result; one whose record is pending is reconciled against what the app holds now
 * (service.ts `#reconcile`), and never run blindly a second time.
 *
 * Kept in `<userData>/agent-control-calls.json` (written atomically, newest `CALL_JOURNAL_MAX`, none older than
 * `CALL_JOURNAL_TTL_MS`).
 */
import { readFileSync } from "node:fs";
import type { AgentControlToolName } from "../../shared/agent-control";
import { writeFileAtomicSync } from "../atomic-file";

export const CALL_JOURNAL_MAX = 500;
export const CALL_JOURNAL_TTL_MS = 3 * 24 * 60 * 60_000;

/** What a pending call set out to do, enough to find its effect again after a relaunch. */
export interface CallIntent {
	/** `ompdesk_session_open`: the task title (`agentTaskTitle`) of each new session it opens. */
	open?: string[];
	/** `ompdesk_schedule` create: the device it saves on (absent = this computer) and the schedule's full name. */
	schedule?: { device?: string; name: string };
}

export interface CallRecord {
	/** `<device>\n<caller's session file>\n<host call id>`: stable across a relaunch, unlike tab ids. */
	key: string;
	tool: AgentControlToolName;
	/** The caller's tab when it began (this launch's id; a relaunch gives the session a new one). */
	callerTabId: string;
	at: number;
	intent?: CallIntent;
	/** Tabs the call opened so far (`note`), written as each one opens: a relaunch finds them by these ids (`formerIds`). */
	opened?: string[];
	/** Absent while the call has not finished (pending). */
	result?: { text: string; isError: boolean };
	/** The host took the result (`acknowledge`): only then may the record be forgotten. */
	acked?: boolean;
}

function parseRecord(value: unknown): CallRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const { key, tool, callerTabId, at, intent, opened, result, acked } = value as Record<string, unknown>;
	if (typeof key !== "string" || !key || typeof tool !== "string" || typeof at !== "number") return null;
	if (typeof callerTabId !== "string") return null;
	const record: CallRecord = { key, tool: tool as AgentControlToolName, callerTabId, at };
	if (typeof intent === "object" && intent !== null) {
		const { open, schedule } = intent as Record<string, unknown>;
		const parsed: CallIntent = {};
		if (Array.isArray(open)) parsed.open = open.filter((title): title is string => typeof title === "string");
		if (typeof schedule === "object" && schedule !== null) {
			const { device, name } = schedule as Record<string, unknown>;
			if (typeof name === "string")
				parsed.schedule = { name, ...(typeof device === "string" && device ? { device } : {}) };
		}
		record.intent = parsed;
	}
	if (Array.isArray(opened)) record.opened = opened.filter((id): id is string => typeof id === "string");
	if (typeof result === "object" && result !== null) {
		const { text, isError } = result as Record<string, unknown>;
		if (typeof text === "string" && typeof isError === "boolean") record.result = { text, isError };
	}
	if (acked === true && record.result) record.acked = true;
	return record;
}

export class CallJournal {
	readonly #file: string | null;
	readonly #now: () => number;
	readonly #records = new Map<string, CallRecord>();

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(value)) return;
			for (const item of value) {
				const record = parseRecord(item);
				if (record) this.#records.set(record.key, record);
			}
		} catch {
			// No record yet, or a damaged one: this launch knows of no earlier call.
		}
	}

	/** The record of a call, however old: one the host has not acknowledged is never forgotten (`#write`). */
	get(key: string): CallRecord | undefined {
		return this.#records.get(key);
	}

	/** Record a call before its effect; written before this returns (a crash right after must find it). */
	begin(record: Omit<CallRecord, "at" | "result">): void {
		this.#records.delete(record.key);
		this.#records.set(record.key, { ...record, at: this.#now() });
		this.#write();
	}

	/** The call's result: a later call with the same identity gets it. */
	finish(key: string, result: { text: string; isError: boolean }): void {
		const record = this.#records.get(key);
		if (!record) return;
		record.result = result;
		this.#write();
	}

	/** The call opened tab `tabId`: written at once, so a crash right after still finds what it opened. */
	note(key: string, tabId: string): void {
		const record = this.#records.get(key);
		if (!record) return;
		record.opened = [...(record.opened ?? []), tabId];
		this.#write();
	}

	/**
	 * The host took the call's result (its `host_tool_result` reached the host's tab): it will never re-send this call,
	 * so the record may now be forgotten by age or count. `callId` is the host call id, the key's last part.
	 */
	acknowledge(callId: string): void {
		for (const record of this.#records.values()) {
			if (!record.key.endsWith(`\n${callId}`) || !record.result || record.acked) continue;
			record.acked = true;
			this.#write();
			return;
		}
	}

	/**
	 * Only acknowledged records go, by age (`CALL_JOURNAL_TTL_MS`) and then oldest first past `CALL_JOURNAL_MAX`: a host
	 * waits on a call with no time limit and may re-send it days later, so a pending or unacknowledged record stays
	 * (they come only from a crash or a lost reply, so they stay few).
	 */
	#write(): void {
		const cutoff = this.#now() - CALL_JOURNAL_TTL_MS;
		for (const [key, record] of this.#records) if (record.acked && record.at < cutoff) this.#records.delete(key);
		let excess = this.#records.size - CALL_JOURNAL_MAX;
		for (const [key, record] of this.#records) {
			if (excess <= 0) break;
			if (!record.acked) continue;
			this.#records.delete(key);
			excess--;
		}
		if (this.#file) writeFileAtomicSync(this.#file, JSON.stringify([...this.#records.values()]));
	}
}
