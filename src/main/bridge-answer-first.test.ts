/**
 * The answer-first companion (resources/gui-bridge/answer-first.ts) and the typed-prompt store it reads
 * (typed-prompts.ts), on a fake `pi`: a person's steer delivered while the loop owns a turn gets the hidden companion
 * right after it; a prompt that starts a turn, a follow-up, an agent's message main never noted, a todo reminder and a
 * subagent's turn get none. The store: a batch of queued texts matches each note in it, both readers take a note once,
 * notes expire.
 */
import { describe, expect, it } from "vitest";
import {
	ANSWER_FIRST_MESSAGE_TYPE,
	ANSWER_FIRST_TEXT,
	methods as answerFirstMethods,
	installAnswerFirst,
} from "../../resources/gui-bridge/answer-first";
import {
	createTypedPrompts,
	methods,
	TYPED_MAX,
	TYPED_TTL_MS,
	typedPrompts,
} from "../../resources/gui-bridge/typed-prompts";

type Hook = (event: { prompt: string }, ctx: { agent: { kind?: string } }) => unknown;

function hook(loopStreaming: () => boolean, typed = createTypedPrompts()) {
	let registered: Hook | undefined;
	installAnswerFirst(
		{
			on: (event, handler) => {
				if (event === "before_agent_start") registered = handler as Hook;
			},
		},
		loopStreaming,
		typed,
	);
	if (!registered) throw new Error("no before_agent_start hook");
	const run = registered;
	return { typed, run: (prompt: string, kind = "main") => run({ prompt }, { agent: { kind } }) };
}

const COMPANION = {
	message: { customType: ANSWER_FIRST_MESSAGE_TYPE, content: ANSWER_FIRST_TEXT, display: false, attribution: "agent" },
};

describe("answer-first companion", () => {
	it("follows a person's steer delivered while the agent loop owns a turn", () => {
		const { typed, run } = hook(() => true);
		typed.note("어느정도 진행되고있어?", true);
		expect(run("어느정도 진행되고있어?")).toEqual(COMPANION);
		// The note is spent: the same words again are not a person's message.
		expect(run("어느정도 진행되고있어?")).toBeUndefined();
	});

	it("gives none to a prompt that starts a turn, a follow-up, or a steer that found the turn over", () => {
		const idle = hook(() => false);
		idle.typed.note("start here", false);
		expect(idle.run("start here")).toBeUndefined();
		idle.typed.note("sent as a steer, delivered as a fresh turn", true);
		expect(idle.run("sent as a steer, delivered as a fresh turn")).toBeUndefined();
		const busy = hook(() => true);
		busy.typed.note("after this, do that", false);
		expect(busy.run("after this, do that")).toBeUndefined();
	});

	it("gives none to a message main never noted: an agent's mail, a reminder, a nudge", () => {
		const { run } = hook(() => true);
		expect(run('<ompdesk-agent-message from="x">\nstatus?\n</ompdesk-agent-message>')).toBeUndefined();
		expect(run("Continue with the next item.")).toBeUndefined();
	});

	it("never answers for a subagent, and leaves its notes for the main session", () => {
		const { typed, run } = hook(() => true);
		typed.note("how far?", true);
		expect(run("how far?", "sub")).toBeUndefined();
		expect(run("how far?")).toEqual(COMPANION);
	});

	it("answers a batch of queued messages once when any of them is a person's steer", () => {
		const { typed, run } = hook(() => true);
		typed.note("first", true);
		typed.note("second", true);
		expect(run("first\n\nsecond")).toEqual(COMPANION);
		expect(typed.take("first\n\nsecond", "answerFirst")).toEqual([]);
	});

	it("registers no bridge method of its own; the note is the typed-prompt area's", async () => {
		expect(Object.keys(answerFirstMethods)).toEqual([]);
		await expect(methods.typed_prompt({ text: "x", steer: true })).resolves.toEqual({ ok: true });
		expect(typedPrompts.take("x", "answerFirst")).toEqual([{ text: "x", steer: true }]);
		await expect(methods.typed_prompt({ steer: true })).rejects.toThrow("needs text");
	});
});

describe("typed prompts", () => {
	it("lets each reader take a note once and drops it once both did", () => {
		const typed = createTypedPrompts();
		typed.note("  a question \n", true);
		expect(typed.take("a question", "recall")).toEqual([{ text: "a question", steer: true }]);
		expect(typed.take("a question", "recall")).toEqual([]);
		expect(typed.size()).toBe(1);
		expect(typed.take("a question", "answerFirst")).toEqual([{ text: "a question", steer: true }]);
		expect(typed.size()).toBe(0);
	});

	it("keeps a note no longer than its TTL, at most the newest few, and never an empty one", () => {
		let now = 1_000;
		const typed = createTypedPrompts(() => now);
		typed.note("   ", true);
		expect(typed.size()).toBe(0);
		typed.note("old", true);
		now += TYPED_TTL_MS;
		expect(typed.take("old", "answerFirst")).toEqual([]);
		for (let i = 0; i < TYPED_MAX + 3; i++) typed.note(`n${i}`, false);
		expect(typed.size()).toBe(TYPED_MAX);
		expect(typed.take("n0", "answerFirst")).toEqual([]);
		expect(typed.take(`n${TYPED_MAX + 2}`, "answerFirst")).toEqual([{ text: `n${TYPED_MAX + 2}`, steer: false }]);
	});
});
