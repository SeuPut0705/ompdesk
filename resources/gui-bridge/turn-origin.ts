/**
 * Who started the main agent's current run: the person's own typed message, or anything else (another agent's
 * message, a report mail, a schedule, Autopilot, a relaunch's continuation). Main asks it (`agent_control.turn`)
 * before a control tool stops, closes or deletes a session the person looks at or typed into: only a run the person's
 * own message started may (src/main/agent-control/service.ts `#stop`).
 *
 * "Typed" is main's word (`typed_prompt`, typed-prompts.ts: a window's or the paired phone page's prompt, a paired
 * device's on its host; never an agent's wrapped message, Autopilot's own prompts or a relaunch's continuation), never
 * the text. A run's prompt messages are the ones stock emits between `agent_start` and its first answer; the run is
 * the person's when one of them is a user message whose whole text a typed note names. A mail that starts a run is a
 * custom message (stock `#promptAgentInitiatedMessage`, no `before_agent_start`), so it is not the person's. A run with
 * no prompt message (stock's retry or continue of the same conversation) keeps the run before it. A message that joins
 * a running turn (a steer, a queued follow-up) never changes who started it.
 *
 * No omp imports: the GUI's vitest installs it on a fake `pi`.
 */
import { type TypedPrompts, typedPrompts } from "./typed-prompts";

interface HookContext {
	agent: { kind?: string };
}

/** The slice of omp's ExtensionAPI this module uses. */
export interface TurnOriginHost {
	on(event: "agent_start", handler: (event: unknown, ctx: HookContext) => void): void;
	on(
		event: "message_start",
		handler: (event: { message: { role: string; content?: unknown } }, ctx: HookContext) => void,
	): void;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("")
		.trim();
}

export interface TurnOrigin {
	/** Registers the hooks on a `pi` (every extension instance; only the main agent's events count). */
	install(pi: TurnOriginHost): void;
	/** Whether the person's own typed message started the main agent's current run. */
	byPerson(): boolean;
}

export function createTurnOrigin(notes: TypedPrompts = typedPrompts): TurnOrigin {
	let person = false;
	/**
	 * After `agent_start`, until the run's first answer: `first` while no prompt message came yet (a run with none keeps
	 * the run before it), `more` once one did (a person's message with extra context after it stays theirs).
	 */
	let opening: "first" | "more" | undefined;
	return {
		install(pi) {
			pi.on("agent_start", (_event, ctx) => {
				if (ctx.agent.kind === "main") opening = "first";
			});
			pi.on("message_start", (event, ctx) => {
				if (ctx.agent.kind !== "main") return;
				const { role } = event.message;
				if (role === "assistant" || role === "toolResult") {
					opening = undefined;
					return;
				}
				// Every user message takes its notes, a steer's too, so none is left to match a later message.
				const text = role === "user" ? messageText(event.message.content) : "";
				const own = role === "user" && notes.take(text, "turn").some(note => note.text === text);
				if (opening === "first") person = own;
				else if (opening === "more") person ||= own;
				if (opening) opening = "more";
			});
		},
		byPerson: () => person,
	};
}

/** The process's record, shared by every extension instance (a subagent's rebind registers hooks that ignore it). */
const origin = createTurnOrigin();

/** Called once per extension instance by index.ts. */
export function install(pi: TurnOriginHost): void {
	origin.install(pi);
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	/** `{}` → `{person}`: whether the person's own typed message started the main agent's current run. */
	"agent_control.turn": async () => ({ person: origin.byPerson() }),
};
