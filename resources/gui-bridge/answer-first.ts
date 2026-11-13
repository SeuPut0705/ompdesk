/**
 * A person's message that joins a running turn is answered first. The owner's case (4 Nov 2026): "어느정도 진행되고
 * 있어?" sent into a session waiting on `wait` cut the wait ("Wait interrupted by message."), and the agent called
 * `wait` again without a word; sixteen minutes later "야 말을해" got a bash call and no answer either.
 *
 * Stock delivers a steer at the next step boundary as a user message in that step's batch, and `before_agent_start`
 * fires for the batch with its text (`prompt`). This handler answers it with one hidden companion, which stock appends
 * right after the batch, in every steering mode (agent-core `#prepareQueuedMessageBatch`: `[...messages,
 * ...additional]`; a companion queued as a steer of its own would be dequeued alone under one-at-a-time, and an aside
 * would cost one more model turn at a stop boundary). It says the person wrote the message above while the agent was
 * working and asks for a text answer in this turn before any further tool call, then to go on with the work.
 *
 * It carries `attribution: "agent"`, not the batch's `user`: a user-attributed hidden message reaches the model as one
 * more user turn, which it skipped as readily as the message itself (measured 4 Nov 2026 on claude-fable-5-1, a fresh
 * session waiting on `sleep 120`: with the stock interjection envelope alone the steer went unanswered in 1 of 3 runs;
 * with a user-attributed companion after it, in 2 of 4). An agent-attributed developer message that follows the
 * user's turn and ends the request is upgraded by pi-ai's Anthropic provider to a mid-conversation `system` turn
 * (`anthropic.ts` `developerParams`), the authority a "do this before anything else" note needs.
 *
 * Only for a message a person typed (main's `typed_prompt`, typed-prompts.ts: never an agent's mail, a todo reminder
 * or an Autopilot nudge), sent to join the turn (`steer`; a follow-up is delivered when the turn would end, where the
 * answer is the natural reply), and delivered while the agent loop owns a turn (`agent.state.isStreaming`: a prompt
 * that starts a turn is prepared before the loop runs). Never for a subagent.
 *
 * The companion alone is ignored often enough (6 Nov 2026, session 15c2371b50c02c9b on 0.112.1: "언제 끝나" during a
 * `wait` got another `wait`, "언제 배포하냐고 물어보잖아" two bash calls and two session messages, and no text for 7
 * minutes). So the hook that adds it also opens a gate: until a response of this turn says something in text, every
 * tool call is refused with {@link ANSWER_FIRST_REFUSAL} (stock's public `tool_call` hook, `block`), except
 * {@link ANSWER_TOOLS}, which the answer itself may need. The gate closes as soon as a response's text streams
 * (`message_update`: agent-core prepares a message's calls, `tool_call` included, when its stream is done and before
 * its `message_end`, so the text is seen first and that response's own calls go through; `message_end` covers a
 * message that never streamed), and at the turn's end (`agent_end`; the person's Stop ends a turn too). Nothing else
 * opens it: a give-way after N silent responses let a model that read twice and then called `wait` skip the answer
 * again. Only after the companion, so only for a person's steer, and only for the main agent.
 *
 * No omp imports (not even types): the GUI's vitest and typecheck load this file directly
 * (src/main/bridge-answer-first.test.ts), as for modes/memory-recall.ts.
 */
import { type TypedPrompts, typedPrompts } from "./typed-prompts";
import { WORD_CHAR } from "./word-char";

export const ANSWER_FIRST_MESSAGE_TYPE = "ompdesk-answer-first";

export const ANSWER_FIRST_TEXT =
	"The person wrote the message above while you were working. Answer it in text now, in this turn, before any further tool call or wait; then continue the work.";

/** The tool result of a call the gate refused. */
export const ANSWER_FIRST_REFUSAL =
	"Not run: the person wrote to you while you were working and you have not answered yet. Answer their message in text first, then call tools again.";

/**
 * Calls the gate lets through: reading (a job's progress in proc://, a file, an agent's output) is what an answer to
 * "how far along is it?" needs, and `ask` is itself addressed to the person. Everything else (wait, bash, edits,
 * messages to other sessions, todo) waits for the text.
 */
const ANSWER_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, find: true, ask: true };

/** The hidden companion, as `before_agent_start` returns it. */
export interface AnswerFirstMessage {
	customType: string;
	content: string;
	display: false;
	attribution: "agent";
}

/** The events this module hears, as omp's ExtensionAPI delivers them; the GUI's vitest installs them on a fake `pi`. */
interface HookContext {
	agent: { kind?: string };
}
interface AssistantEvent {
	message: { role: string; content?: unknown };
}

/** The slice of omp's ExtensionAPI this module uses. */
export interface AnswerFirstHost {
	on(
		event: "before_agent_start",
		handler: (event: { prompt: string }, ctx: HookContext) => { message: AnswerFirstMessage } | undefined,
	): void;
	on(event: "message_update" | "message_end", handler: (event: AssistantEvent) => void): void;
	on(event: "agent_end", handler: () => void): void;
	on(
		event: "tool_call",
		handler: (event: { toolName: string }, ctx: HookContext) => { block: true; reason: string } | undefined,
	): void;
}

/**
 * Whether an assistant message says anything to the person (a lone "." or blank text is not an answer). A narration
 * block counts: Anthropic streams prose addressed to the person as a thinking block whose signature names it
 * narration (pi-ai `ThinkingContent.narration`), and stock shows it as answer text (pi-ai `presentNarrationAsAnswer`).
 * A claude-opus-5-5 session answered a steer that way and the gate refused its call twice (01a1a7f1, 5 Nov 2026).
 */
function saysSomething(message: AssistantEvent["message"]): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some((block: { type?: unknown; text?: unknown; thinking?: unknown; narration?: unknown }) => {
		const said =
			block?.type === "text"
				? block.text
				: block?.type === "thinking" && block.narration === true
					? block.thinking
					: undefined;
		return typeof said === "string" && WORD_CHAR.test(said);
	});
}

/** The live main session's agent loop, as omp's package index reaches it. */
interface AnswerFirstApi extends AnswerFirstHost {
	pi: {
		MAIN_AGENT_ID: unknown;
		AgentRegistry: {
			global(): { get(id: unknown): { session: { agent: { state: { isStreaming: boolean } } } } | undefined };
		};
	};
}

/** Whether the agent loop owns a turn right now (the batch being prepared joins it). */
export type LoopStreaming = () => boolean;

/** The companion for a batch, or nothing. Pure given the store and the loop's state. */
export function answerFirstCompanion(
	prompt: string,
	agentKind: string | undefined,
	loopStreaming: boolean,
	notes: TypedPrompts,
): AnswerFirstMessage | undefined {
	if (agentKind !== "main") return undefined;
	const typed = notes.take(prompt, "answerFirst");
	if (!loopStreaming || !typed.some(note => note.steer)) return undefined;
	return { customType: ANSWER_FIRST_MESSAGE_TYPE, content: ANSWER_FIRST_TEXT, display: false, attribution: "agent" };
}

/** The hook on a fake `pi` (tests) or on omp's; `loopStreaming` reads the live loop at each turn's start. */
export function installAnswerFirst(
	pi: AnswerFirstHost,
	loopStreaming: LoopStreaming,
	notes: TypedPrompts = typedPrompts,
): void {
	/** A person's steer this turn has not answered in text yet. */
	let owed = false;
	pi.on("before_agent_start", (event, ctx) => {
		const message = answerFirstCompanion(event.prompt, ctx.agent.kind, loopStreaming(), notes);
		if (!message) return undefined;
		owed = true;
		return { message };
	});
	const heard = (event: AssistantEvent) => {
		if (owed && saysSomething(event.message)) owed = false;
	};
	pi.on("message_update", heard);
	pi.on("message_end", heard);
	pi.on("agent_end", () => {
		owed = false;
	});
	pi.on("tool_call", (event, ctx) => {
		if (!owed || ctx.agent.kind !== "main" || ANSWER_TOOLS[event.toolName]) return undefined;
		return { block: true, reason: ANSWER_FIRST_REFUSAL };
	});
}

/** Called once per extension instance by index.ts (and again on a subagent's rebind, where `kind` is never main). */
export function install(pi: AnswerFirstApi): void {
	installAnswerFirst(
		pi,
		() => pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session.agent.state.isStreaming === true,
	);
}

export const methods: Record<string, (params: unknown, env: never) => Promise<unknown>> = {};
