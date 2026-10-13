import type { AgentSessionEvent, SubagentFrame } from "../src/shared/rpc-types";

export type RecordedWorkFrame =
	| { atMs: number; channel: "main"; events: AgentSessionEvent[] }
	| { atMs: number; channel: "subagent"; frame: SubagentFrame };

const replayRoot = "/tmp/ompdesk-real-replay";

/** Keep actual wire order and payloads, including stock interruptions. Scrub
 * complete paths AND paths split across streaming argument/text deltas. */
export function scrubWorkRecording(source: readonly RecordedWorkFrame[], privateRoot: string): RecordedWorkFrame[] {
	const recording = structuredClone(source);
	const streams = new Map<string, Array<{ delta: string }>>();
	for (const frame of recording) {
		const events =
			frame.channel === "main"
				? frame.events
				: frame.frame.type === "subagent_event"
					? [frame.frame.payload.event]
					: [];
		const scope =
			frame.channel === "main" ? "main" : frame.frame.type === "subagent_event" ? frame.frame.payload.id : "";
		for (const event of events) {
			if (event.type !== "message_update") continue;
			const update = event.assistantMessageEvent;
			if (!("delta" in update) || typeof update.delta !== "string" || !("contentIndex" in update)) continue;
			const key = `${scope}:${update.partial?.timestamp ?? event.message.timestamp ?? 0}:${update.contentIndex}:${update.type}`;
			const stream = streams.get(key) ?? [];
			stream.push(update);
			streams.set(key, stream);
		}
	}
	for (const stream of streams.values()) {
		const joined = stream.map(update => update.delta).join("");
		const spans: Array<[number, number]> = [];
		let index = joined.indexOf(privateRoot);
		while (index !== -1) {
			spans.push([index, index + privateRoot.length]);
			index = joined.indexOf(privateRoot, index + privateRoot.length);
		}
		let offset = 0;
		for (const update of stream) {
			const end = offset + update.delta.length;
			let cursor = offset;
			let replacement = "";
			for (const [start, stop] of spans) {
				if (stop <= offset || start >= end) continue;
				replacement += update.delta.slice(cursor - offset, Math.max(cursor, start) - offset);
				if (start >= offset) replacement += replayRoot;
				cursor = Math.min(end, stop);
			}
			replacement += update.delta.slice(cursor - offset);
			update.delta = replacement;
			offset = end;
		}
	}
	function scrub(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (key === "cwd") return `${replayRoot}/project`;
			if (key === "sessionFile") return `${replayRoot}/session.jsonl`;
			return value.replaceAll(privateRoot, replayRoot);
		}
		if (Array.isArray(value)) return value.map(item => scrub(item));
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([name]) =>
						!/^(credentialId|providerPayload|apiKey|accessToken|refreshToken|authorization|signature)$/.test(
							name,
						),
				)
				.map(([name, item]) => [name, scrub(item, name)]),
		);
	}
	return recording.map(frame => ({ ...(scrub(frame) as RecordedWorkFrame), atMs: Math.round(frame.atMs / 8) }));
}

/** Rebase an owned decoded fixture, never the on-disk real recording. Transcript clocks move to
 * `started` and run 8× faster, like the replay itself; measured wall/progress durations stay as
 * recorded. So a replayed card's run clock (stock message timestamps: 16.9 s recorded → 2.1 s)
 * reads shorter than its lanes' measured times (10.9 s, 9.9 s); a live run shows no such gap. */
export function rebaseWorkRecording(recording: RecordedWorkFrame[], started = Date.now()): RecordedWorkFrame[] {
	const timestamps = new Map<Record<string, unknown>, number>();
	let epoch = Number.POSITIVE_INFINITY;
	function visit(value: unknown): void {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const object = value as Record<string, unknown>;
		if (typeof object.timestamp === "number") {
			timestamps.set(object, object.timestamp);
			epoch = Math.min(epoch, object.timestamp);
		}
		for (const item of Object.values(object)) visit(item);
	}
	visit(recording);
	for (const [object, timestamp] of timestamps) object.timestamp = started + Math.round((timestamp - epoch) / 8);
	return recording;
}

/** Play a recording in fixed segments: segment `n` ends at `stops[n]` (inclusive),
 * the last one at the final frame. Each call plays the next segment and resolves
 * whether it reached the end. A call made while an earlier segment still plays
 * queues behind it: segments share one cursor, so overlapping loops would skip,
 * repeat and reorder frames (a stale progress after completion, or the whole run
 * at once when the cursor sat mid-segment). Calls past the end are no-ops. */
export function createWorkReplay(
	recording: readonly RecordedWorkFrame[],
	stops: readonly number[],
	emit: (frame: RecordedWorkFrame) => void,
	wait: (ms: number) => Promise<void>,
): () => Promise<boolean> {
	let cursor = 0;
	let segment = 0;
	let playing = Promise.resolve(false);
	const play = async (): Promise<boolean> => {
		if (cursor >= recording.length) return false;
		const end = Math.min(stops[segment++] ?? recording.length - 1, recording.length - 1);
		let previous = recording[cursor].atMs;
		for (; cursor <= end; cursor++) {
			const item = recording[cursor];
			const delay = item.atMs - previous;
			if (delay > 0) await wait(delay);
			previous = item.atMs;
			emit(item);
		}
		return cursor === recording.length;
	};
	return () => {
		playing = playing.then(play);
		return playing;
	};
}
