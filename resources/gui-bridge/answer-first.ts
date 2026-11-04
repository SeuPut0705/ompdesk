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
 * Only for a message a person typed (main's `typed_prompt`, typed-prompts.ts: never an agent's mail, a todo reminder
 * or an Autopilot nudge), sent to join the turn (`steer`; a follow-up is delivered when the turn would end, where the
 * answer is the natural reply), and delivered while the agent loop owns a turn (`agent.state.isStreaming`: a prompt
 * that starts a turn is prepared before the loop runs). Never for a subagent.
 *
 * No omp imports (not even types): the GUI's vitest and typecheck load this file directly
 * (src/main/bridge-answer-first.test.ts), as for modes/memory-recall.ts.
 */
import { type TypedPrompts, typedPrompts } from "./typed-prompts";

export const ANSWER_FIRST_MESSAGE_TYPE = "ompdesk-answer-first";

export const ANSWER_FIRST_TEXT =
	"The person wrote the message above while you were working. Answer it in text now, in this turn, before any further tool call or wait; then continue the work.";

/** The slice of omp's ExtensionAPI this module uses; the GUI's vitest installs it on a fake `pi`. */
export interface AnswerFirstHost {
	on(
		event: "before_agent_start",
		handler: (
			event: { prompt: string },
			ctx: { agent: { kind?: string } },
		) => { message: { customType: string; content: string; display: boolean } } | undefined,
	): void;
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
): { customType: string; content: string; display: boolean } | undefined {
	if (agentKind !== "main") return undefined;
	const typed = notes.take(prompt, "answerFirst");
	if (!loopStreaming || !typed.some(note => note.steer)) return undefined;
	return { customType: ANSWER_FIRST_MESSAGE_TYPE, content: ANSWER_FIRST_TEXT, display: false };
}

/** The hook on a fake `pi` (tests) or on omp's; `loopStreaming` reads the live loop at each turn's start. */
export function installAnswerFirst(
	pi: AnswerFirstHost,
	loopStreaming: LoopStreaming,
	notes: TypedPrompts = typedPrompts,
): void {
	pi.on("before_agent_start", (event, ctx) => {
		const message = answerFirstCompanion(event.prompt, ctx.agent.kind, loopStreaming(), notes);
		return message ? { message } : undefined;
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
