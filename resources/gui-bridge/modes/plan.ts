/**
 * Plan mode and structured plan approval (port of the fork's rpc-plan.ts).
 *
 * Stock RPC has no plan commands; its AgentSession does: `setPlanModeState`,
 * `setPlanProposalHandler`, `preparePlanForReview`. Entering mirrors the TUI's
 * `#enterPlanMode` minus the plan-role model switch: the built-in `write` tool
 * is ensured (plan drafts and `xd://propose` are writes) and the pre-plan tool
 * set restored on exit. When the agent proposes, the proposal is pushed as a
 * `plan_proposal` frame and the turn is silently aborted, the same stop the TUI
 * and print mode perform, until `plan_approval` resolves it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import {
	attach,
	emit,
	errorMessage,
	ompPackage,
	ompPrompt,
	onSessionEvent,
	onSessionSwitch,
	record,
	submitTurn,
} from "./shared";

/** Options advertised on the `plan_proposal` frame (TUI review parity). */
const PLAN_PROPOSAL_OPTIONS = ["execute", "compact", "keep_context", "save", "refine"];

type ApprovalOption = "execute" | "compact" | "keep_context" | "save";

interface ProposalFrame {
	planFilePath: string;
	title: string;
	suggestedFileName: string;
	planContent: string;
	options: string[];
}

interface PendingProposal {
	planFilePath: string;
	title: string;
	/**
	 * The `plan_proposal` frame once emitted, i.e. the proposal is awaiting the
	 * host's answer. The frame is a one-shot event a renderer that was not
	 * listening yet (reloaded, restored) never sees, so `get_plan_mode` returns
	 * it too: the tab re-shows it on hydrate.
	 */
	frame?: ProposalFrame;
}

let pending: PendingProposal | undefined;
let installedHandler: PlanProposalHandler | undefined;
/** Active tools before plan mode added `write`; restored when it ends. */
let previousTools: string[] | undefined;

function planState(session: AgentSession): { enabled: boolean; planFilePath?: string } {
	const state = session.getPlanModeState();
	return { enabled: state?.enabled ?? false, planFilePath: state?.planFilePath };
}

function localOptions(session: AgentSession) {
	const manager = session.sessionManager;
	return {
		getArtifactsDir: () => manager.getArtifactsDir(),
		getSessionId: () => manager.getSessionId(),
	};
}

async function readPlan(session: AgentSession, planFilePath: string): Promise<string | null> {
	const { readPlanFile } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-files");
	return readPlanFile(planFilePath, {
		localProtocolOptions: localOptions(session),
		cwd: session.sessionManager.getCwd(),
	});
}

/** Install the proposal handler; never clobbers a foreign one (prewalk's plan-yolo installs its own). */
function arm(session: AgentSession): void {
	if (installedHandler && session.peekPlanProposalHandler() === installedHandler) return;
	if (session.peekPlanProposalHandler()) return;
	// Print mode's handler: validate and shape the proposal, promote the reviewed path, journal it.
	installedHandler = async title => {
		const result = await session.preparePlanForReview(title);
		const details = result.details;
		if (details) {
			const state = session.getPlanModeState();
			if (state?.enabled) session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
			session.sessionManager.appendModeChange("plan", { planFilePath: details.planFilePath });
			pending = { planFilePath: details.planFilePath, title: details.title };
		}
		return result;
	};
	session.setPlanProposalHandler(installedHandler);
}

function disarm(session: AgentSession): void {
	if (installedHandler && session.peekPlanProposalHandler() === installedHandler) {
		session.setPlanProposalHandler(null);
	}
	installedHandler = undefined;
	pending = undefined;
}

/** Leave plan mode (session-level subset of the TUI's `#tearDownPlanMode`). */
async function exitPlanMode(session: AgentSession): Promise<void> {
	session.setPlanModeState(undefined);
	disarm(session);
	const restore = previousTools;
	previousTools = undefined;
	if (restore) await session.setActiveToolsByName(restore);
	session.sessionManager.appendModeChange("none");
}

async function enterPlanMode(session: AgentSession): Promise<void> {
	const goal = session.getGoalModeState();
	if (goal?.enabled || goal?.goal?.status === "paused") throw new Error("Exit goal mode first.");
	if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");
	const planFilePath = session.getPlanReferencePath() || "local://PLAN.md";
	const before = session.getEnabledToolNames();
	const previousState = session.getPlanModeState();
	// Plan state lands before the tool change: approval is a top-level `write` to `xd://propose`.
	session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel" });
	if (session.hasBuiltInTool("write") && !before.includes("write")) {
		try {
			await session.setActiveToolsByName([...before, "write"]);
		} catch (error) {
			session.setPlanModeState(previousState);
			throw error;
		}
	}
	previousTools = before;
	arm(session);
	if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
	session.sessionManager.appendModeChange("plan", { planFilePath });
}

async function onProposalWritten(event: AgentSessionEvent, session: AgentSession): Promise<void> {
	if (event.type !== "tool_execution_end" || event.isError) return;
	const proposal = pending;
	if (!proposal) return;
	const { writeDeviceDispatch } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
	const { PROPOSE_DEVICE_NAME } = await import("@oh-my-pi/pi-tui/tools/resolve");
	const dispatch = writeDeviceDispatch(event.toolName, event.result);
	if (dispatch?.tool !== PROPOSE_DEVICE_NAME || dispatch.mode !== "execute") return;
	const suggestedFileName: string = ompPackage().planSaveFileName?.(proposal.title) ?? "PLAN.md";
	const frame: ProposalFrame = {
		planFilePath: proposal.planFilePath,
		title: proposal.title,
		suggestedFileName,
		planContent: (await readPlan(session, proposal.planFilePath)) ?? "",
		options: [...PLAN_PROPOSAL_OPTIONS],
	};
	proposal.frame = frame;
	emit({ type: "plan_proposal", ...frame });
	session.markPlanInternalAbortPending();
	try {
		await session.abort();
	} finally {
		session.clearPlanInternalAbortPending();
	}
}

onSessionEvent((event, session) => {
	void onProposalWritten(event, session).catch(error =>
		emit({ type: "notice", level: "error", message: `Plan proposal failed: ${errorMessage(error)}` }),
	);
});

// A proposal belongs to the transcript that produced it.
onSessionSwitch(() => {
	pending = undefined;
});

function reportTurnError(error: unknown): void {
	emit({ type: "notice", level: "error", message: `Plan turn failed: ${errorMessage(error)}` });
}

async function approve(session: AgentSession, params: Record<string, unknown>): Promise<unknown> {
	const proposal = pending;
	if (!proposal) throw new Error("No plan is awaiting approval");

	if (params.approved !== true) {
		pending = undefined;
		const feedback = typeof params.feedback === "string" ? params.feedback.trim() : "";
		if (feedback) {
			void submitTurn(session, feedback, false).catch(reportTurnError);
			return { approved: false, dispatched: true };
		}
		return { approved: false, dispatched: false, reason: "rejected" };
	}

	const option = (typeof params.option === "string" ? params.option : "execute") as ApprovalOption;
	const { planFilePath } = proposal;
	const planContent = await readPlan(session, planFilePath);
	if (!planContent) throw new Error(`Plan file not found at ${planFilePath}`);

	if (option === "save") {
		const savePath = typeof params.savePath === "string" ? params.savePath.trim() : "";
		if (!savePath || !path.isAbsolute(savePath)) throw new Error("Saving a plan requires an absolute savePath");
		await fs.writeFile(savePath, planContent);
		await exitPlanMode(session);
		try {
			const freshSessionStarted = await session.newSession();
			return {
				approved: true,
				dispatched: false,
				reason: freshSessionStarted ? "saved" : "saved; new session cancelled",
				savedPath: savePath,
				freshSessionStarted,
			};
		} catch (error) {
			return {
				approved: true,
				dispatched: false,
				reason: `saved; new session failed: ${errorMessage(error)}`,
				savedPath: savePath,
				freshSessionStarted: false,
			};
		}
	}

	await exitPlanMode(session);
	const { prompt } = await import("@oh-my-pi/pi-utils");

	if (option === "execute") {
		// Fresh session carrying the session-local artifacts forward (TUI #approvePlan);
		// local:// is session-scoped, so the plan is rewritten into the new local root.
		const { copyLocalArtifacts, resolveLocalUrlToPath } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
		const oldLocalRoot = resolveLocalUrlToPath("local://", localOptions(session));
		await session.newSession();
		const newLocalRoot = resolveLocalUrlToPath("local://", localOptions(session));
		await copyLocalArtifacts(oldLocalRoot, newLocalRoot);
		const newLocalPath = resolveLocalUrlToPath(planFilePath, localOptions(session));
		await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
		await fs.writeFile(newLocalPath, planContent);
	} else if (option === "compact") {
		// Pin the reference before compaction so queued turns see the approved plan.
		session.setPlanReferencePath(planFilePath);
		try {
			await session.compact(
				prompt.render(ompPrompt("system/plan-mode-compact-instructions.md"), { planFilePath }),
			);
		} catch (error) {
			// Approval stands; execution waits for the host's next prompt (TUI cancelled branch).
			return { approved: true, dispatched: false, reason: `compaction failed: ${errorMessage(error)}` };
		}
	}

	session.setPlanReferencePath(planFilePath);
	session.markPlanReferenceSent();
	const { humanizePlanTitle } = await import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan");
	const seededName = humanizePlanTitle(proposal.title);
	if (seededName && !session.sessionManager.getSessionName()) await session.setSessionName(seededName, "auto");
	const approvedPrompt = prompt.render(ompPrompt("system/plan-mode-approved.md"), {
		planFilePath,
		contextPreserved: option !== "execute",
	});
	void submitTurn(session, approvedPrompt, true).catch(reportTurnError);
	return { approved: true, dispatched: true };
}

export const methods: BridgeMethods = guard("planMode", {
	"modes.get_plan_mode": async (_params, env) => {
		const session = attach(env);
		// A resumed or switched-to session may already carry plan mode.
		if (session.getPlanModeState()?.enabled) arm(session);
		// `proposal`: the emitted proposal still awaiting `plan_approval`, if any.
		return { ...planState(session), proposal: pending?.frame };
	},
	"modes.set_plan_mode": async (params, env) => {
		const session = attach(env);
		const enabled = record(params).enabled === true;
		if (enabled === (session.getPlanModeState()?.enabled === true)) {
			if (enabled) arm(session);
			return planState(session);
		}
		if (enabled) await enterPlanMode(session);
		else await exitPlanMode(session);
		return planState(session);
	},
	"modes.plan_approval": async (params, env) => {
		return approve(attach(env), record(params));
	},
});
