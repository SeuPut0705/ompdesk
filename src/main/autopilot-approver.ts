/**
 * Autopilot's approver. An autopilot session runs with the runtime override `tools.approvalMode = yolo`,
 * yet a card still appears when a tool asks for one itself or the user's own `tools.approval.<tool>: prompt`
 * stands. Nobody watches an autopilot run, so main answers: a card whose text breaks a hard limit is Denied
 * (the same pure rules as the bridge guard and the audit), any other Approved. Deterministic, immediate, no
 * model. Questions that remain (extensions, MCP elicitation) get the recommended option or are declined; a
 * child's go to its parent (`ompdesk_session_answer`), not here.
 */

import type { AutopilotShipPolicy } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { findBanViolation } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import { AGENT_CARD_PREFIX, isApprovalSelect } from "../shared/agent-control";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../shared/rpc-types";

/** What the approver needs to know about an autopilot tab. */
export interface ApproverRun {
	role: "parent" | "child";
	root: string;
	ship: AutopilotShipPolicy;
	/** The release scope is open for the turn in progress (a due release or a verified user request). */
	oneShotRelease: boolean;
	defaultBranch: string;
}

export interface ApprovalDecision {
	answer: "Approve" | "Deny";
	reason?: string;
}

function shipLevel(ship: AutopilotShipPolicy): "local" | "push" | "release" {
	if (ship.autoRelease.on) return "release";
	return ship.autoPush ? "push" : "local";
}

/** The card's text: its title (tool and arguments) and the option details. */
function cardText(request: Extract<ExtensionUIRequest, { method: "select" }>): string {
	const details = (request.optionDetails ?? []).map(detail => detail.description ?? "").filter(Boolean);
	return [request.title.replace(/^Allow tool:\s*/, ""), ...details].join("\n");
}

/** Approve unless the card's text breaks a hard limit under the run's ship level. */
export function decideApproval(request: ExtensionUIRequest, run: ApproverRun): ApprovalDecision {
	if (request.method !== "select") return { answer: "Deny", reason: "not an approval card" };
	const reason = findBanViolation(cardText(request), {
		root: run.root,
		shipLevel: shipLevel(run.ship),
		// A child never opens the release scope.
		oneShotRelease: run.role === "parent" && run.oneShotRelease,
		role: run.role,
		remote: run.ship.remote,
		defaultBranch: run.defaultBranch,
	});
	return reason ? { answer: "Deny", reason } : { answer: "Approve" };
}

/** A remaining question: the recommended option of every `ask` question, otherwise declined. */
export function decideQuestion(request: ExtensionUIRequest): ExtensionUIResponse {
	const declined: ExtensionUIResponse = { type: "extension_ui_response", id: request.id, cancelled: true };
	if (request.method !== "ask") return declined;
	const answers: Array<{ id: string; selectedOptions: string[] }> = [];
	for (const question of request.questions) {
		const label = question.recommended === undefined ? undefined : question.options[question.recommended]?.label;
		if (label === undefined) return declined;
		answers.push({ id: question.id, selectedOptions: [label] });
	}
	return answers.length > 0 ? { type: "extension_ui_response", id: request.id, answers } : declined;
}

export interface ApproverDeps {
	/** The autopilot run a tab belongs to (parent or child); undefined for any other tab. */
	runOf(tabId: string): ApproverRun | undefined;
	/** Send the answer to the tab's omp (`SidecarPool.routeSideChannel`). */
	answer(tabId: string, response: ExtensionUIResponse): Promise<void>;
	/** A card was Denied (the reason is for the log and the notification). */
	denied?(tabId: string, reason: string): void;
}

export class AutopilotApprover {
	readonly #deps: ApproverDeps;
	readonly #pending = new Set<Promise<void>>();

	constructor(deps: ApproverDeps) {
		this.#deps = deps;
	}

	/** Called for every extension-UI request of a tab; true when this approver took (answers) it. */
	handle(tabId: string, request: ExtensionUIRequest): boolean {
		const run = this.#deps.runOf(tabId);
		if (!run) return false;
		let response: ExtensionUIResponse;
		if (request.method === "select" && isApprovalSelect(request)) {
			const decision = decideApproval(request, run);
			if (decision.reason) this.#deps.denied?.(tabId, decision.reason);
			response = { type: "extension_ui_response", id: request.id, value: decision.answer };
		} else if (run.role === "child") {
			return false;
		} else if (
			request.method === "ask" ||
			request.method === "confirm" ||
			request.method === "select" ||
			request.method === "editor"
		) {
			// The control tools' own cards (stop, close, delete, merge) are the person's to answer.
			if ("title" in request && request.title.startsWith(AGENT_CARD_PREFIX)) return false;
			response = decideQuestion(request);
		} else {
			return false;
		}
		const sent = this.#deps
			.answer(tabId, response)
			.catch(() => undefined)
			.finally(() => this.#pending.delete(sent));
		this.#pending.add(sent);
		return true;
	}

	/** Resolves once every answer started so far has been sent (tests, shutdown). */
	async idle(): Promise<void> {
		await Promise.all([...this.#pending]);
	}
}
