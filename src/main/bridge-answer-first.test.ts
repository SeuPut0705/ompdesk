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
	ANSWER_FIRST_REFUSAL,
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
type Handler = (event: Record<string, unknown>, ctx: { agent: { kind?: string } }) => unknown;

function hook(loopStreaming: () => boolean, typed = createTypedPrompts()) {
	const handlers = new Map<string, Handler>();
	installAnswerFirst(
		{
			on: (event: string, handler: unknown) => {
				handlers.set(event, handler as Handler);
			},
		},
		loopStreaming,
		typed,
	);
	const registered = handlers.get("before_agent_start") as Hook | undefined;
	if (!registered) throw new Error("no before_agent_start hook");
	const run = registered;
	const fire = (event: string, payload: Record<string, unknown>, kind = "main") =>
		handlers.get(event)?.({ type: event, ...payload }, { agent: { kind } });
	const call = (toolName: string, kind = "main") =>
		fire("tool_call", { toolName, toolCallId: `${toolName}-1`, input: {} }, kind);
	/**
	 * One assistant response in stock's order: its text streams (`message_update`), its calls are prepared when the
	 * stream is done (`tool_call`, agent-core's prepare before `message_end`), then `message_end`. The calls' answers.
	 */
	const respond = (content: Array<Record<string, unknown>>, ...tools: string[]) => {
		const message = { role: "assistant", content };
		fire("message_update", { message, assistantMessageEvent: { type: "text_delta" } });
		const results = tools.map(tool => call(tool));
		fire("message_end", { message });
		return results;
	};
	return { typed, run: (prompt: string, kind = "main") => run({ prompt }, { agent: { kind } }), fire, call, respond };
}

const waitCall = { type: "toolCall", id: "wait-1", name: "wait", arguments: {} };

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

describe("answer-first gate", () => {
	it("refuses a wait the agent calls without a word after a person's steer, and lets work resume once it answered", () => {
		const { typed, run, respond } = hook(() => true);
		typed.note("언제 끝나", true);
		expect(run("언제 끝나")).toEqual(COMPANION);
		// The session 15c2371b50c02c9b's reply to the steer: another wait, no text. What an answer needs (a read of
		// the job, a question to the person) goes through.
		const refused = { block: true, reason: ANSWER_FIRST_REFUSAL };
		expect(respond([waitCall], "wait", "bash", "read", "ask")).toEqual([refused, refused, undefined, undefined]);
		// The next response says something to the person: its own calls run, and so does the work after it.
		const answer = { type: "text", text: "release-check는 e2e 2/2 단계이고 10분쯤 남았습니다." };
		expect(respond([answer, waitCall], "wait")).toEqual([undefined]);
		expect(respond([waitCall], "bash")).toEqual([undefined]);
	});

	it("holds only after a person's steer and only the main agent, through silent reads, until text or the turn's end", () => {
		const mail = hook(() => true);
		expect(mail.run('<ompdesk-agent-message from="x">\nstatus?\n</ompdesk-agent-message>')).toBeUndefined();
		expect(mail.respond([waitCall], "wait")).toEqual([undefined]);

		const { typed, run, call, respond, fire } = hook(() => true);
		typed.note("how far?", true);
		run("how far?");
		expect(call("wait", "sub")).toBeUndefined();
		// Silent reads go through, and never count as the answer: the wait after them is still refused.
		expect(respond([{ type: "text", text: "." }], "read")).toEqual([undefined]);
		expect(respond([], "read")).toEqual([undefined]);
		expect(respond([waitCall], "wait")).toEqual([expect.objectContaining({ block: true })]);
		expect(respond([waitCall], "wait")).toEqual([expect.objectContaining({ block: true })]);

		// The turn's end (a Stop included) closes it.
		fire("agent_end", { messages: [] });
		expect(respond([waitCall], "wait")).toEqual([undefined]);
	});

	it("counts a narration block as the answer, as stock shows it, and never plain reasoning", () => {
		const { typed, run, respond } = hook(() => true);
		typed.note("성능저하 기능저하 없이 제대로 작동하는것이 중요함", true);
		run("성능저하 기능저하 없이 제대로 작동하는것이 중요함");
		// The bot's response 987 in 01a1a7f1 (claude-opus-5-5, 5 Nov 2026): its reasoning, then its answer to the person
		// as a narration block (Anthropic's signature kind; pi-ai `presentNarrationAsAnswer` renders it as text), then
		// the call. The gate refused it.
		const reasoning = {
			type: "thinking",
			thinking: "The gate seems to be catching me, so I'm going to answer first.",
		};
		expect(respond([reasoning, waitCall], "write")).toEqual([expect.objectContaining({ block: true })]);
		const narration = {
			type: "thinking",
			narration: true,
			thinking:
				"세 가지 조건(더 느려지지 않을 것, 기존 기능 유지, 기존 시험 통과)을 지키는 변경만 넣겠다고 정했어요.",
		};
		expect(respond([reasoning, narration, waitCall], "write")).toEqual([undefined]);
	});
});

describe("typed prompts", () => {
	it("lets each reader take a note once and drops it once every reader did", () => {
		const typed = createTypedPrompts();
		typed.note("  a question \n", true);
		expect(typed.take("a question", "recall")).toEqual([{ text: "a question", steer: true }]);
		expect(typed.take("a question", "recall")).toEqual([]);
		expect(typed.size()).toBe(1);
		expect(typed.take("a question", "answerFirst")).toEqual([{ text: "a question", steer: true }]);
		expect(typed.size()).toBe(1);
		expect(typed.take("a question", "turn")).toEqual([{ text: "a question", steer: true }]);
		expect(typed.size()).toBe(0);
	});

	it("keeps a second identical steer's note for its own batch (one-at-a-time delivers them one by one)", () => {
		const { typed, run } = hook(() => true);
		typed.note("어느정도 됐어?", true);
		typed.note("어느정도 됐어?", true);
		expect(run("어느정도 됐어?")).toEqual(COMPANION);
		expect(run("어느정도 됐어?")).toEqual(COMPANION);
		expect(run("어느정도 됐어?")).toBeUndefined();
		// A batch that carries both at once takes both.
		typed.note("x", true);
		typed.note("x", true);
		expect(typed.take("x\n\nx", "answerFirst")).toHaveLength(2);
		expect(typed.take("x", "answerFirst")).toEqual([]);
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
