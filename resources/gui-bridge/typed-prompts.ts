/**
 * Prompts a person typed, as main says them: `typed_prompt {text, steer}` comes over the bridge just before the
 * prompt, steer or follow-up itself reaches the omp (src/main/local/prompt-origin.ts `noteTypedPrompt`: this
 * computer's windows and the paired phone page in ipc.ts, a paired device's prompt in remote/host-services.ts; never
 * an agent's wrapped message, Autopilot's own prompts, a relaunch's continuation or a retry). `steer` says the sender
 * meant it to join the running turn (stock `steer`, or `prompt` with `streamingBehavior: "steer"`).
 *
 * Readers find a note at the turn that delivers its text (`before_agent_start`, whose `prompt` is the text or, for a
 * batch of queued messages, the texts joined): memory recall in an Autopilot run (modes/memory-recall.ts) and the
 * answer-first companion (answer-first.ts); and at the user message itself (`message_start`): who started the run
 * (turn-origin.ts). Each takes a note once for itself; a note is dropped once every reader took it, or after
 * {@link TYPED_TTL_MS}, or past {@link TYPED_MAX} newer ones.
 *
 * No omp imports: the GUI's vitest loads this file directly (src/main/bridge-answer-first.test.ts).
 */

/** How long a note waits for its turn (a steer waits for the running tool's end), and how many are kept. */
export const TYPED_TTL_MS = 30 * 60_000;
export const TYPED_MAX = 16;

export type TypedReader = "recall" | "answerFirst" | "turn";
const READERS: readonly TypedReader[] = ["recall", "answerFirst", "turn"];

export interface TypedPrompt {
	text: string;
	steer: boolean;
}

interface Note extends TypedPrompt {
	at: number;
	taken: Set<TypedReader>;
}

export interface TypedPrompts {
	note(text: string, steer: boolean): void;
	/** The live notes this reader has not taken whose text is `prompt` or sits in it, taken for this reader. */
	take(prompt: string, reader: TypedReader): TypedPrompt[];
	/** For tests. */
	size(): number;
}

export function createTypedPrompts(now: () => number = Date.now): TypedPrompts {
	let notes: Note[] = [];
	const live = () => {
		notes = notes.filter(note => now() - note.at < TYPED_TTL_MS);
	};
	return {
		note(text, steer) {
			const trimmed = text.trim();
			if (!trimmed) return;
			live();
			notes = [...notes.slice(-(TYPED_MAX - 1)), { text: trimmed, steer, at: now(), taken: new Set() }];
		},
		take(prompt, reader) {
			live();
			const batch = prompt.trim();
			// As many notes of a text as the batch carries, oldest first: two identical steers queued one at a time are
			// two batches, and the second keeps its note for its own turn.
			const room = new Map<string, number>();
			const found: Note[] = [];
			for (const note of notes) {
				if (note.taken.has(reader)) continue;
				const left = room.get(note.text) ?? occurrences(batch, note.text);
				if (left === 0) continue;
				room.set(note.text, left - 1);
				found.push(note);
				note.taken.add(reader);
			}
			notes = notes.filter(note => !READERS.every(name => note.taken.has(name)));
			return found.map(({ text, steer }) => ({ text, steer }));
		},
		size: () => notes.length,
	};
}

/** How many times `text` sits in `batch`, without overlap. */
function occurrences(batch: string, text: string): number {
	let count = 0;
	for (let at = batch.indexOf(text); at >= 0; at = batch.indexOf(text, at + text.length)) count++;
	return count;
}

/** The process's notes, shared by every reader (a subagent's rebind sees the same module). */
export const typedPrompts: TypedPrompts = createTypedPrompts();

/** `typed_prompt {text, steer}`: main's word, just before the message goes in, that a person typed it. */
export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	typed_prompt: async params => {
		const record = params as { text?: unknown; steer?: unknown } | null;
		if (typeof record?.text !== "string") throw new Error("typed_prompt needs text");
		typedPrompts.note(record.text, record.steer === true);
		return { ok: true };
	},
};
