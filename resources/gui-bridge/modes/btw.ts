/**
 * `/btw` side questions (port of the fork's rpc-btw.ts onto stock 18.6.1, whose
 * RPC has no btw commands). One side question runs at a time against the main
 * session through `session.runEphemeralTurn`; its answer streams as `btw_delta`
 * frames and every lifecycle change as a `btw_record` frame. Each turn is
 * checkpointed into the session's stock `BtwHistoryStore`, so the TUI and the
 * GUI read and continue the same topics.
 */
import type { BtwHistoryRecord, BtwHistoryStore, BtwHistoryTurn } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { attach, emit, errorMessage, ompPrompt, onSessionSwitch, record } from "./shared";

interface RunningBtw {
	record: BtwHistoryRecord;
	store: BtwHistoryStore;
	abort: AbortController;
}

const CANCELLED_WHILE_STARTING = "The /btw question was cancelled before it started";

let store: BtwHistoryStore | undefined;
/** `sessionId \0 artifactsDir` the store was opened for. */
let storeKey: string | undefined;
let running: RunningBtw | undefined;
/** Topic of a `btw` between validation and its first checkpoint (`null`: a new topic). */
let startingTopic: string | null | undefined;
/** Bumped by every cancel and session change; a `btw` still starting from before gives up. */
let epoch = 0;
/** Terminal checkpoint writes still in flight. */
const writes = new Set<Promise<void>>();
/** Terminal checkpoints that failed, keyed by record id (latest wins); retried before any move. */
const unsaved = new Map<string, RunningBtw>();

function notice(message: string): void {
	emit({ type: "notice", level: "error", message, source: "btw-history" });
}

/** Patch the record's latest turn (the last follow-up, else the record itself). */
function patchLatest(target: BtwHistoryRecord, patch: Partial<BtwHistoryTurn>): BtwHistoryRecord {
	const followUps = target.followUps;
	if (followUps?.length) {
		return { ...target, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }] };
	}
	return { ...target, ...patch };
}

/** Record the turn's terminal state once; later outcomes of the same turn are ignored. */
function finish(turn: RunningBtw, patch: Partial<BtwHistoryTurn>): void {
	if (running !== turn) return;
	running = undefined;
	turn.record = patchLatest(turn.record, patch);
	emit({ type: "btw_record", record: turn.record });
	const write = turn.store.upsert(turn.record).then(
		() => {
			unsaved.delete(turn.record.id);
		},
		error => {
			unsaved.set(turn.record.id, turn);
			notice(`Could not save /btw history: ${errorMessage(error)}`);
		},
	);
	writes.add(write);
	void write.finally(() => writes.delete(write));
}

function cancel(recordId?: string): boolean {
	const turn = running;
	if (turn) {
		if (recordId !== undefined && turn.record.id !== recordId) return false;
		epoch++;
		finish(turn, { status: "cancelled", updatedAt: Date.now() });
		turn.abort.abort();
		return true;
	}
	if (startingTopic === undefined || (recordId !== undefined && startingTopic !== recordId)) return false;
	epoch++;
	return true;
}

/** Await terminal checkpoints, retrying failed ones once against their original revision. */
async function settleWrites(): Promise<void> {
	while (writes.size > 0) await Promise.all(writes);
	for (const [id, failed] of unsaved) {
		try {
			await failed.store.retry(failed.record);
			unsaved.delete(id);
		} catch (error) {
			// A conflicting retry (the topic changed or vanished on disk) can never succeed.
			if (errorMessage(error).includes("BTW history conflict")) {
				unsaved.delete(id);
				notice(`/btw answer ${id} was not saved: it changed or was removed on disk`);
				continue;
			}
			throw new Error(`/btw history could not be saved: ${errorMessage(error)}`, { cause: error });
		}
	}
}

/**
 * The current session's store with queued checkpoints landed. `fresh` re-reads a
 * persisted store from disk (topics the TUI wrote); only while nothing runs here.
 */
async function openStore(session: AgentSession, fresh: boolean): Promise<BtwHistoryStore> {
	const manager = session.sessionManager;
	const artifactsDir = manager.getArtifactsDir() ?? undefined;
	const key = `${manager.getSessionId()}\0${artifactsDir ?? ""}`;
	const cached = storeKey === key ? store : undefined;
	if (cached) {
		try {
			await cached.flush();
			// Without an artifacts dir the store is the only copy: never drop it.
			if (!fresh || artifactsDir === undefined) return cached;
		} catch {
			// The failed checkpoint was already reported; re-read from disk below.
			if ([...unsaved.values()].some(failed => failed.store === cached)) return cached;
		}
	} else if (running) {
		// The session was replaced: its question must not stream into this one's view.
		cancel();
	}
	const { BtwHistoryStore: Store } = await import("@oh-my-pi/pi-coding-agent/session/btw-history");
	const opened = await Store.open(artifactsDir);
	if (storeKey === key && store !== cached && store) return store;
	store = opened;
	storeKey = key;
	return opened;
}

async function runTurn(
	session: AgentSession,
	turn: RunningBtw,
	question: string,
	history: readonly BtwHistoryTurn[] | undefined,
	conversationKey: string,
): Promise<void> {
	if (running !== turn) return;
	try {
		const model = session.model;
		if (!model) throw new Error("No active model available for /btw.");
		const { prompt } = await import("@oh-my-pi/pi-utils");
		const { getBtwLatestTurn } = await import("@oh-my-pi/pi-coding-agent/session/btw-history");
		const template = ompPrompt("system/btw-user.md");
		const messages = [];
		for (const past of history ?? []) {
			messages.push({
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt.render(template, { question: past.question }) }],
				attribution: "agent" as const,
				timestamp: past.createdAt,
			});
			if (!past.answer) continue;
			// Saved history holds visible text only; these are context, not billed turns.
			messages.push({
				role: "assistant" as const,
				content: [{ type: "text" as const, text: past.answer }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: past.updatedAt,
			});
		}
		const { replyText } = await session.runEphemeralTurn({
			promptText: prompt.render(template, { question }),
			history: messages,
			conversationKey,
			// Answers are read in full and saved: keep the repeat collapse, not the one-liner cap.
			replyMaxBytes: Number.POSITIVE_INFINITY,
			onTextDelta: delta => {
				if (running !== turn) return;
				const latest = getBtwLatestTurn(turn.record);
				turn.record = patchLatest(turn.record, { answer: latest.answer + delta, updatedAt: Date.now() });
				emit({ type: "btw_delta", recordId: turn.record.id, delta });
			},
			signal: turn.abort.signal,
		});
		finish(turn, { answer: replyText, status: "complete", updatedAt: Date.now() });
	} catch (error) {
		finish(turn, { status: "error", error: errorMessage(error), updatedAt: Date.now() });
	}
}

/** Start a side question (or a follow-up in topic `recordId`); resolves once checkpointed as running. */
async function ask(session: AgentSession, question: string, recordId?: string): Promise<BtwHistoryRecord> {
	const trimmed = question.trim();
	if (!trimmed) throw new Error("btw requires a non-empty question");
	if (startingTopic !== undefined || running) throw new Error("A /btw question is still running; cancel it first");
	startingTopic = recordId ?? null;
	const startEpoch = epoch;
	try {
		await settleWrites();
		const opened = await openStore(session, true);
		if (startEpoch !== epoch) throw new Error(CANCELLED_WHILE_STARTING);
		const previous = recordId === undefined ? undefined : opened.getRecords().find(r => r.id === recordId);
		if (recordId !== undefined && !previous) throw new Error(`Unknown /btw topic: ${recordId}`);
		if (!session.model) throw new Error("No active model available for /btw.");
		const manager = session.sessionManager;
		await manager.ensureOnDisk();
		if (startEpoch !== epoch) throw new Error(CANCELLED_WHILE_STARTING);

		const { Snowflake } = await import("@oh-my-pi/pi-utils");
		const { getBtwTurns } = await import("@oh-my-pi/pi-coding-agent/session/btw-history");
		const now = Date.now();
		const turn: BtwHistoryTurn = { question: trimmed, answer: "", status: "running", createdAt: now, updatedAt: now };
		const created: BtwHistoryRecord = previous
			? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
			: { ...turn, id: Snowflake.next(), leafId: manager.getLeafId() };
		const history = previous ? getBtwTurns(previous) : undefined;
		// A cancelled or failed transport may still be unwinding: start a fresh provider lineage after it.
		const transportEpoch = (history?.findLastIndex(item => item.status !== "complete") ?? -1) + 1;
		const conversationKey = `btw:${created.id}:${transportEpoch}`;
		try {
			await opened.upsert(created);
		} catch (error) {
			throw new Error(`Could not save /btw history: ${errorMessage(error)}`, { cause: error });
		}
		const current: RunningBtw = { record: created, store: opened, abort: new AbortController() };
		running = current;
		emit({ type: "btw_record", record: created });
		if (startEpoch !== epoch) {
			finish(current, { status: "cancelled", updatedAt: Date.now() });
			throw new Error(CANCELLED_WHILE_STARTING);
		}
		// A macrotask: the `btw` response reaches the GUI before this turn's frames.
		setTimeout(() => void runTurn(session, current, trimmed, history, conversationKey), 0);
		return created;
	} finally {
		startingTopic = undefined;
	}
}

/** Newest first, re-read from disk when idle; a running topic carries its live partial answer. */
async function historyRecords(session: AgentSession): Promise<BtwHistoryRecord[]> {
	const opened = await openStore(session, running === undefined && startingTopic === undefined);
	const records = new Map(opened.getRecords().map(entry => [entry.id, entry]));
	for (const failed of unsaved.values()) {
		if (failed.store === opened) records.set(failed.record.id, failed.record);
	}
	if (running?.store === opened) records.set(running.record.id, running.record);
	return [...records.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

// The replaced session's question stops; its checkpoints still land in its own store.
onSessionSwitch(() => {
	epoch++;
	cancel();
});

export const methods: BridgeMethods = guard("btw", {
	"modes.btw": async (params, env) => {
		const { question, recordId } = record(params);
		if (typeof question !== "string") throw new Error("btw requires a non-empty question");
		const created = await ask(attach(env), question, typeof recordId === "string" ? recordId : undefined);
		return { record: created };
	},
	"modes.btw_cancel": async (params, env) => {
		attach(env);
		const { recordId } = record(params);
		return { cancelled: cancel(typeof recordId === "string" ? recordId : undefined) };
	},
	"modes.get_btw_history": async (_params, env) => ({ records: await historyRecords(attach(env)) }),
});
