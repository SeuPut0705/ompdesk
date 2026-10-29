/**
 * A tab's subagent transcripts as this window holds them, read on from where the last read stopped.
 *
 * Stock writes each subagent's journal as JSONL, and both reads (stock `get_subagent_messages`, the bridge's
 * `get_subagent_transcript` for an agent stock's registry forgot) answer the whole lines after `fromByte` with the
 * offset to read from next. So a transcript crosses once: the work card's replay of a finished agent, its lane while
 * it runs, the replay at its completion and its Subagent view all read on from one cursor, and an agent read after it
 * settled is not asked again until it runs once more (its settled mark changes). A read waits while the window is
 * hidden. Before this every replay and every view mount read the whole journal again; on a paired device that was
 * 11.5 MB in the minute after it reconnected (the host's `traffic` line, 28 Oct 2026).
 */
import { timeoutForCommand } from "../../shared/rpc-client";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { whenVisible } from "../lib/visible-poll";

type Command = (command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;

export interface HeldTranscript {
	/** Every message read so far, in order; the same array after a read that added nothing. */
	messages: AgentMessage[];
	/** The journal offset the next read starts at. */
	nextByte: number;
}

export interface TranscriptRead extends HeldTranscript {
	/** What this read brought: all of it when it started over. */
	incoming: AgentMessage[];
}

export interface TranscriptReadOptions {
	/** The journal stock's registry names for the agent. */
	sessionFile?: string;
	/** The agent's settled mark (`settledMark` in subagents.ts), absent while it may still write. */
	settled?: string;
	/** Read the journal from its start again (a retry after a failure). */
	restart?: boolean;
}

export interface SubagentTranscripts {
	held(id: string): HeldTranscript | undefined;
	/** Reads what the journal holds past the cursor; one read at a time per agent. Rejects with the read's error. */
	read(id: string, options?: TranscriptReadOptions): Promise<TranscriptRead>;
	clear(): void;
}

interface Entry extends HeldTranscript {
	/** The settled mark the last read was made under. */
	settled?: string;
	/** Stock's registry forgot the agent: its journal is read from the session's artifacts dir. */
	stored: boolean;
	/** A read succeeded: until then nothing is held, so a view shows its first read loading. */
	loaded: boolean;
	pending?: Promise<void>;
}

interface TranscriptData {
	messages?: AgentMessage[];
	nextByte?: number;
	reset?: boolean;
}

/** The same transcript again: as long, ending on the same message. */
function sameTail(shown: readonly AgentMessage[], reread: readonly AgentMessage[]): boolean {
	const last = reread.at(-1);
	return (
		shown.length === reread.length &&
		(last === undefined || (shown.at(-1)?.timestamp === last.timestamp && shown.at(-1)?.role === last.role))
	);
}

export function createSubagentTranscripts(command: Command): SubagentTranscripts {
	let entries = new Map<string, Entry>();
	const send = (rpc: RpcCommand) => command(rpc, timeoutForCommand(rpc));

	const ask = async (id: string, entry: Entry, fromByte: number, sessionFile?: string): Promise<TranscriptData> => {
		const stored = { type: "get_subagent_transcript", subagentId: id, fromByte } as const;
		if (entry.stored) {
			const response = await send(stored);
			if (!response.success) throw new Error(response.error);
			return (response.data ?? {}) as TranscriptData;
		}
		const response = await send({
			type: "get_subagent_messages",
			subagentId: id,
			...(sessionFile ? { sessionFile } : {}),
			fromByte,
		});
		if (response.success) return (response.data ?? {}) as TranscriptData;
		// Stock's RPC registry forgets settled agents across a relaunch; their transcripts stay in the session's
		// artifacts dir.
		const fallback = await send(stored);
		if (!fallback.success) throw new Error(response.error);
		entry.stored = true;
		return (fallback.data ?? {}) as TranscriptData;
	};

	return {
		held: id => {
			const entry = entries.get(id);
			return entry?.loaded ? { messages: entry.messages, nextByte: entry.nextByte } : undefined;
		},
		read: (id, options = {}) => {
			let entry = entries.get(id);
			if (!entry) {
				entry = { messages: [], nextByte: 0, stored: false, loaded: false };
				entries.set(id, entry);
			}
			const current = entry;
			const run = async (): Promise<TranscriptRead> => {
				if (!options.restart && options.settled !== undefined && current.settled === options.settled)
					return { messages: current.messages, nextByte: current.nextByte, incoming: [] };
				const shown = whenVisible();
				if (shown) await shown;
				const fromByte = options.restart ? 0 : current.nextByte;
				const data = await ask(id, current, fromByte, options.sessionFile);
				const incoming = data.messages ?? [];
				if (data.reset === true || fromByte === 0) {
					if (data.reset === true || !sameTail(current.messages, incoming)) current.messages = incoming;
				} else if (incoming.length > 0) current.messages = [...current.messages, ...incoming];
				current.nextByte = data.nextByte ?? fromByte;
				current.settled = options.settled;
				current.loaded = true;
				return { messages: current.messages, nextByte: current.nextByte, incoming };
			};
			// Each read starts where the one before it stopped.
			const result = current.pending ? current.pending.then(run) : run();
			const done = result.then(
				() => undefined,
				() => undefined,
			);
			current.pending = done;
			void done.then(() => {
				if (current.pending === done) current.pending = undefined;
			});
			return result;
		},
		clear: () => {
			entries = new Map();
		},
	};
}
