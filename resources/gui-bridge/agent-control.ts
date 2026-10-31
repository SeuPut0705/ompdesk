/**
 * OMPdesk control tools (src/shared/agent-control.ts, executed in main by src/main/agent-control/): the parts that
 * need the live session.
 * - A risky tool call (stopping, closing, deleting or merging for another session) is held in main until the person
 *   approves it on a confirmation card, and that card is stock's own extension-UI `confirm` raised by the calling
 *   tab's omp (`ctx.ui.confirm`, as /omfg asks where to save a rule), so it renders, survives a reload, is answered
 *   once across windows and reaches a paired device exactly like every other approval.
 * - When an agent answers another session's question, the answered session journals it (`ompdesk.agent-answer`
 *   custom entry, so the answer is auditable there) and says so (`ctx.ui.notify`, a toast in its window).
 * - A session another session's agent opened (`ompdesk_session_open`, Autopilot children included) journals
 *   `ompdesk.worker` before its first prompt; while that entry is on its branch its main agent gets the short worker
 *   contract (`WORKER_CONTRACT`) as a registered prompt section. The journal, not process state, carries it, so a
 *   relaunched child keeps it and a session the user opened never gets it.
 * - The owner's bot session (src/main/agent-control/bot.ts) journals `ompdesk.bot` with the owner's action rules each
 *   time they change (the latest entry wins); while one is on its branch its main agent gets the bot role and those
 *   rules (`botSection`) as the `ompdesk-bot` prompt section. No entry, no section.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`.
 */
import { hasMailEntry, MAIL_CUSTOM_TYPE } from "./agent-control-contracts";
import { crossFamily, JUDGE_ROLES, modelFamily } from "./agent-control-judge-core";
import { completeOnSmol, type ModelLike, type NextPromptSession } from "./modes/next-prompt-engine";
import { type PromptSectionContext, type PromptSectionHost, registerPromptSection } from "./prompt-sections";

/**
 * The slice of `BridgeEnv` (types.ts) these methods touch. types.ts imports omp's own types, which the GUI's `tsc`
 * cannot resolve where omp is not installed, and a module the GUI's tests import must not pull it in.
 */
interface ControlSession {
	/** Stock `AgentSession.isStreaming`: a turn runs (or a prompt is being set up). */
	isStreaming: boolean;
	sessionManager: {
		getBranch(): { customType?: unknown; data?: unknown }[];
		appendCustomEntry(customType: string, data: unknown): unknown;
	};
}
interface ControlEnv {
	session(): ControlSession;
	context(): {
		ui: { confirm(title: string, message: string): Promise<unknown>; notify(message: string, type: "info"): void };
	};
}
type BridgeMethods = Record<string, (params: unknown, env: ControlEnv) => Promise<unknown>>;

const TEXT_MAX = 2000;
/** The judge's evidence is bounded in main; this is the last guard. */
const JUDGE_INPUT_MAX = 120_000;
/** A judge reads a long evidence prompt and writes a verdict; main waits 180 s for the reply. */
const JUDGE_DEADLINE_MS = 170_000;
export const AGENT_ANSWER_ENTRY = "ompdesk.agent-answer";
export const WORKER_ENTRY = "ompdesk.worker";
export const BOT_ENTRY = "ompdesk.bot";
/** The rules text is a prompt line per rule; this is the last guard on its size. */
const BOT_RULES_MAX = 20_000;

/** What a session opened by another agent should know about its role; kept short and plain. */
export const WORKER_CONTRACT = `<ompdesk-worker>
Another agent opened this session and handed you its first message; the person sees this tab and may also write to you.
- Work only in this session's folder. When a message or a result names an absolute path in another checkout, do not read or write it; ask instead.
- Never use \`git stash\`: every worktree of a repository shares one stash, so another session's stash can land in yours. Commit work in progress to your branch instead.
- Stay inside the files and scope the message names. If the task needs more, say so in your answer rather than widening it.
- Done means the observable acceptance in the message holds, checked by you, and any requested commit is on your branch.
- Your final answer is what the other agent reads: what changed (files, commits), how you checked it with the actual result, and anything left undone.
- End your final answer with one last line: \`Result: ok\` when the acceptance holds and every check you ran passed, else \`Result: problem — <reason>\` (a failed or skipped check, work left undone). The other agent reads that line, not your prose. That final answer is delivered to it automatically as your done report: do not send a done report yourself.
- Use ompdesk_report only for question or blocked when you need its decision (then wait for its answer; never guess an approval), progress at real milestones, and kind note with to set to a sibling it opened. Pass the dispatch id its message names.
- Keep replying to the person in their language when they write to you.
</ompdesk-worker>`;

/** The bot's role, short and plain: what the owner expects of it, then their rules for actions. */
export function botSection(rules: string): string {
	return `<ompdesk-bot>
You are the owner's always-on bot.
- When the owner gives you a responsibility, open sessions for the work with ompdesk_session_open and follow them until done. Their questions and reports come back to you.
- When the owner asks, work in their own sessions with the control tools.
- Bring the owner results, and only the decisions that need them, with ompdesk_notify.
- Plan follow-ups and wake yourself to check later with ompdesk_schedule {"target":"self"}; cancel a wake you no longer need.
- Follow the owner's rules for actions below. An irreversible action is never automatic unless a rule says auto.
${rules.trim() ? `Rules:\n${rules.trim()}` : "The owner set no rules: ask before anything irreversible."}
</ompdesk-bot>`;
}

/** The rules text of the newest `ompdesk.bot` entry on the branch, or undefined when this is not the bot's session. */
export function botRulesOf(ctx: PromptSectionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.customType !== BOT_ENTRY) continue;
		const rules = (entry.data as { rules?: unknown } | undefined)?.rules;
		return typeof rules === "string" ? rules : undefined;
	}
	return undefined;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`agent_control needs a ${field}`);
	return value.slice(0, TEXT_MAX);
}

/** True when this session was opened by another session's agent. */
export function isWorkerSession(ctx: PromptSectionContext): boolean {
	return ctx.sessionManager.getBranch().some(entry => entry.customType === WORKER_ENTRY);
}

interface MailMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

/** Stock's `pi.sendMessage` (a custom message, journaled and shown per its delivery). */
interface MailHost {
	sendMessage(message: MailMessage, options?: { triggerTurn?: boolean; deliverAs?: "aside" }): void;
}

/** The main session's `pi` (the first install; a subagent's rebinding never replaces it). */
let mailHost: MailHost | undefined;

export function install(pi: PromptSectionHost & Partial<MailHost>): void {
	if (!mailHost && typeof pi.sendMessage === "function") mailHost = pi as MailHost;
	// The main agent only: its own subagents are briefed by it, not by this contract.
	registerPromptSection(pi, "ompdesk-worker", ctx =>
		ctx.agent.kind === "main" && isWorkerSession(ctx) ? WORKER_CONTRACT : undefined,
	);
	registerPromptSection(pi, "ompdesk-bot", ctx => {
		if (ctx.agent.kind !== "main") return undefined;
		const rules = botRulesOf(ctx);
		return rules === undefined ? undefined : botSection(rules);
	});
}

/** Report ids this process handed to stock (an aside is journaled only once the receiver's loop takes it). */
const queuedMail = new Set<string>();

export const methods: BridgeMethods = {
	/**
	 * `{content, details, triggerTurn, deliverAs?}` → `{}`: a report from another session (`ompdesk_report`), as one
	 * stock custom message: journaled with the session (a relaunch neither loses nor repeats it), shown as a quiet line,
	 * and delivered by stock's own rules (`aside` at the next step boundary, an interruptible `wait` returning on it;
	 * `triggerTurn` wakes an idle session). A no-turn report (`triggerTurn: false`, no `deliverAs`) that finds a turn
	 * running goes as an `aside` too: stock's no-turn delivery into a running turn would steer (cutting the tool batch)
	 * and its `nextTurn` stays hidden until the person's next prompt.
	 */
	"agent_control.mail": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const content = typeof record.content === "string" ? record.content : "";
		if (!content.trim()) throw new Error("agent_control.mail needs content");
		if (!mailHost) throw new Error("This omp cannot receive reports (no extension sendMessage).");
		const details = (record.details ?? {}) as Record<string, unknown>;
		const id = typeof details.id === "string" ? details.id : undefined;
		// Idempotent across restarts of either side: the journal is the record of what arrived, and until stock's loop
		// takes a queued aside this process remembers it. `journaled` tells main which of the two it is: main keeps a
		// report until the receiver's journal holds it (a killed omp loses an aside it still queued).
		const branch = env.session().sessionManager.getBranch();
		const journaled = id !== undefined && hasMailEntry(branch, id);
		if (id && (journaled || queuedMail.has(id))) return { duplicate: true, journaled };
		if (id) queuedMail.add(id);
		const message = { customType: MAIL_CUSTOM_TYPE, content, display: true, details };
		// Idle, an aside starts a turn (stock), so a no-turn report keeps stock's plain idle delivery: shown at once.
		const deliverAs = record.deliverAs === "aside" || env.session().isStreaming ? "aside" : undefined;
		const triggerTurn = record.triggerTurn === true;
		mailHost.sendMessage(message, { triggerTurn, ...(deliverAs ? { deliverAs } : {}) });
		return {};
	},
	/** `{title, message}` → `{approved}`: a dismissed or cancelled card is a refusal. */
	"agent_control.confirm": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const approved = await env.context().ui.confirm(text(record.title, "title"), text(record.message, "message"));
		return { approved: approved === true };
	},
	/** `{text}` → `{}`: this session was answered by an agent. */
	"agent_control.note": async (params, env) => {
		const label = text((params as Record<string, unknown> | null)?.text, "text");
		env.session().sessionManager.appendCustomEntry(AGENT_ANSWER_ENTRY, { text: label, at: Date.now() });
		env.context().ui.notify(label, "info");
		return {};
	},
	/** `{from}` → `{}`: this session was opened by the agent of the session titled `from`; once per session. */
	"agent_control.worker": async (params, env) => {
		const from = text((params as Record<string, unknown> | null)?.from, "from").slice(0, 200);
		const manager = env.session().sessionManager;
		if (!manager.getBranch().some((entry: { customType?: unknown }) => entry.customType === WORKER_ENTRY))
			manager.appendCustomEntry(WORKER_ENTRY, { from, at: Date.now() });
		return {};
	},
	/**
	 * `{rules}` → `{changed}`: this is the owner's bot session and these are the owner's rules for its actions (the
	 * text `botRulesText` builds, empty when the owner set none). Journaled as `ompdesk.bot` only when they differ from
	 * the newest entry, so a session main tells again at every start journals them once; the newest entry wins.
	 */
	"agent_control.bot": async (params, env) => {
		const rules = (params as { rules?: unknown } | null)?.rules;
		if (typeof rules !== "string") throw new Error("agent_control needs rules");
		const manager = env.session().sessionManager;
		const next = rules.slice(0, BOT_RULES_MAX);
		const last = botRulesOf({ sessionManager: manager, agent: { kind: "main" } });
		if (last === next) return { changed: false };
		manager.appendCustomEntry(BOT_ENTRY, { rules: next, at: Date.now() });
		return { changed: true };
	},
	/**
	 * `{system, user}` → `{text, model, role, family, mainModel, mainFamily, crossFamily, usd?, tokens?}`: the control
	 * tools' judge (`ompdesk_compare` with criteria), one request on stock's `advisor` role, then `slow` (each with its
	 * fallbacks per `resolveRoleChain`), never the session's own model. A candidate whose family (`Model.identity.class`)
	 * differs from the session's model is preferred, so the judge does not grade its own lineage; when none does, or a
	 * family is unknown, the first credentialed candidate judges and `crossFamily` says so (false, or null when either
	 * family is unknown). Journaled in stock's usage ledger as `ompdesk-judge`. Main builds the prompt from the
	 * compared sessions' evidence and turns a rejection (no model, no credentials, a failed request) into `unavailable`.
	 */
	"agent_control.judge": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const system = typeof record.system === "string" ? record.system : "";
		const user = typeof record.user === "string" ? record.user : "";
		if (!system.trim() || !user.trim()) throw new Error("agent_control.judge needs {system, user}");
		const session = env.session() as unknown as NextPromptSession & { model?: ModelLike };
		const main = session.model ?? null;
		const judged = await completeOnSmol(session, {
			system,
			user: user.slice(0, JUDGE_INPUT_MAX),
			maxTokens: 2_000,
			temperature: 0,
			purpose: "ompdesk-judge",
			roles: JUDGE_ROLES,
			prefer: model => crossFamily(model, main) !== false,
			deadlineMs: JUDGE_DEADLINE_MS,
		});
		return {
			text: judged.text,
			model: judged.model,
			role: judged.role,
			family: modelFamily(judged.modelRef),
			mainModel: main ? `${main.provider}/${main.id}` : null,
			mainFamily: modelFamily(main),
			crossFamily: crossFamily(judged.modelRef, main),
			...(judged.usd === undefined ? {} : { usd: judged.usd }),
			...(judged.tokens === undefined ? {} : { tokens: judged.tokens }),
		};
	},
};
