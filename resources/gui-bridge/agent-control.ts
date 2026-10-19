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
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`.
 */
import { completeOnSmol } from "./modes/next-prompt-engine";
import { type PromptSectionContext, type PromptSectionHost, registerPromptSection } from "./prompt-sections";

/**
 * The slice of `BridgeEnv` (types.ts) these methods touch. types.ts imports omp's own types, which the GUI's `tsc`
 * cannot resolve where omp is not installed, and a module the GUI's tests import must not pull it in.
 */
interface ControlEnv {
	session(): {
		sessionManager: {
			getBranch(): { customType?: unknown }[];
			appendCustomEntry(customType: string, data: unknown): unknown;
		};
	};
	context(): {
		ui: { confirm(title: string, message: string): Promise<unknown>; notify(message: string, type: "info"): void };
	};
}
type BridgeMethods = Record<string, (params: unknown, env: ControlEnv) => Promise<unknown>>;

const TEXT_MAX = 2000;
/** The judge's evidence is bounded in main; this is the last guard. */
const JUDGE_INPUT_MAX = 120_000;
export const AGENT_ANSWER_ENTRY = "ompdesk.agent-answer";
export const WORKER_ENTRY = "ompdesk.worker";

/** What a session opened by another agent should know about its role; kept short and plain. */
export const WORKER_CONTRACT = `<ompdesk-worker>
Another agent opened this session and handed you its first message; the person sees this tab and may also write to you.
- Work only in this session's folder. When a message or a result names an absolute path in another checkout, do not read or write it; ask instead.
- Stay inside the files and scope the message names. If the task needs more, say so in your answer rather than widening it.
- Done means the observable acceptance in the message holds, checked by you, and any requested commit is on your branch.
- Your final answer is what the other agent reads: what changed (files, commits), how you checked it with the actual result, and anything left undone.
- End your final answer with one last line: \`Result: ok\` when the acceptance holds and every check you ran passed, else \`Result: problem — <reason>\` (a failed or skipped check, work left undone). The other agent reads that line, not your prose.
- Keep replying to the person in their language when they write to you.
</ompdesk-worker>`;

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`agent_control needs a ${field}`);
	return value.slice(0, TEXT_MAX);
}

/** True when this session was opened by another session's agent. */
export function isWorkerSession(ctx: PromptSectionContext): boolean {
	return ctx.sessionManager.getBranch().some(entry => entry.customType === WORKER_ENTRY);
}

export function install(pi: PromptSectionHost): void {
	// The main agent only: its own subagents are briefed by it, not by this contract.
	registerPromptSection(pi, "ompdesk-worker", ctx =>
		ctx.agent.kind === "main" && isWorkerSession(ctx) ? WORKER_CONTRACT : undefined,
	);
}

export const methods: BridgeMethods = {
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
	 * `{system, user}` → `{text, model, usd?, tokens?}`: the control tools' judge (`ompdesk_compare` with criteria), one
	 * request on stock's `slow` role (its fallbacks per `resolveRoleChain`), never the session's own model, journaled in
	 * stock's usage ledger as `ompdesk-judge`. Main builds the prompt from the compared sessions' evidence.
	 */
	"agent_control.judge": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const system = typeof record.system === "string" ? record.system : "";
		const user = typeof record.user === "string" ? record.user : "";
		if (!system.trim() || !user.trim()) throw new Error("agent_control.judge needs {system, user}");
		return completeOnSmol(env.session() as never, {
			system,
			user: user.slice(0, JUDGE_INPUT_MAX),
			maxTokens: 2_000,
			temperature: 0,
			purpose: "ompdesk-judge",
			role: "slow",
		});
	},
};
