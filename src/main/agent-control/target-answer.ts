/**
 * An answer that carries attachments (`ompdesk_session_answer`) is ONE step on the computer that runs the answered
 * session (`agent_control_answer`): a stock answer (an extension-UI response, a plan approval) carries text only, so what
 * the answer attaches goes into the session first, as a quiet note, and then the question is answered. The step is made
 * where the question lives, so a paired device's session is answered by its own host's main (the command crosses the
 * link like any other), never by two steps over a link that may drop between them.
 *
 * - The question must still be open: when it is gone, nothing is appended and the answer is refused.
 * - The note is appended before the answer and is idempotent by its own id (the receiver's bridge refuses a repeat).
 * - The step is idempotent by `requestId`: a resend after a lost reply finds it done and appends and answers nothing.
 * - A plan proposal is claimed the same way, by its plan file, and the approval is sent only while that very proposal is
 *   still the pending one (`planStillClaimed`); a replacement proposal gets nothing.
 * - The question is claimed in the tick that finds it open (`SidecarPool.claimRequest`): the person's card, another
 *   agent and a paired device are refused (`being_answered`) until this answer lands or the claim is released. If the
 *   note cannot be appended the claim is released and nothing was delivered. The only partial case left is omp itself
 *   cancelling the question while the note goes in (a turn aborted), outside main's control: it is said explicitly.
 */
import type { ExtensionUIResponse, RpcCommand } from "../../shared/rpc-types";

export interface AnswerCompanion {
	content: string | { type: string; [key: string]: unknown }[];
	details: Record<string, unknown>;
	delivery: { triggerTurn: boolean; deliverAs?: "aside" };
}

export type AnswerStep = { requestId: string; companion: AnswerCompanion } & (
	| { askId: string; response: ExtensionUIResponse }
	| { plan: RpcCommand; planFile: string; planGeneration: number }
);

export interface TargetAnswerDeps {
	/** Whether the question `id` is still open on `tabId`. */
	askOpen(tabId: string, id: string): boolean;
	/** Take the plan proposal at `planFile` that `tabId` waits on; null when it is not that plan or already taken. */
	claimPlan(tabId: string, planFile: string, generation: number): symbol | null;
	/** Whether the claimed plan is still the pending one (a replacement proposal is not). */
	planStillClaimed(tabId: string, claim: symbol): boolean;
	releasePlan(tabId: string, claim: symbol): void;
	/** Take the question so no other answer lands; null when it is not open or already taken. */
	claim(tabId: string, id: string): symbol | null;
	/** Give a claimed question back unanswered. */
	release(id: string, claim: symbol): void;
	/** Put the claimed answer to the question to its omp (which also ends the claim). */
	route(tabId: string, id: string, response: ExtensionUIResponse, claim: symbol): Promise<boolean>;
}

/**
 * A command to the answered session's omp, through the dispatcher of the call. `own` marks the plan approval this step
 * claimed the plan for: the dispatcher lets it through while it refuses every other approval of a claimed plan.
 */
export type SendCommand = (command: RpcCommand, own?: boolean) => Promise<{ success: boolean; error?: string }>;

/** What was settled this long ago is forgotten: a resend comes within a retry, not days later. */
const DONE_KEPT = 200;

export class TargetAnswer {
	readonly #deps: TargetAnswerDeps;
	readonly #done = new Set<string>();
	readonly #running = new Map<string, Promise<void>>();

	constructor(deps: TargetAnswerDeps) {
		this.#deps = deps;
	}

	/** Runs the step; rejects with what the sender reads when the answer was not given. */
	run(tabId: string, step: AnswerStep, send: SendCommand): Promise<void> {
		const key = `${tabId}\n${step.requestId}`;
		if (this.#done.has(key)) return Promise.resolve();
		const running = this.#running.get(key);
		if (running) return running;
		const work = this.#step(tabId, step, send).then(() => {
			this.#done.add(key);
			const oldest = this.#done.values().next().value;
			if (this.#done.size > DONE_KEPT && oldest !== undefined) this.#done.delete(oldest);
		});
		const settled = work.finally(() => this.#running.delete(key));
		this.#running.set(key, settled);
		return settled;
	}

	async #step(tabId: string, step: AnswerStep, send: SendCommand): Promise<void> {
		const deps = this.#deps;
		const gone = new Error(
			"That question is not open any more, or another answer holds it: nothing was added to the session and nothing answered.",
		);
		const { content, details, delivery } = step.companion;
		const note = {
			type: "agent_control_mail",
			content,
			details,
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}),
		} as RpcCommand;
		const failed = (why: string | undefined) =>
			new Error(
				`what goes with the answer could not be delivered (${why ?? "no reason given"}). Neither the attachments nor the answer were sent.`,
			);
		if (!("askId" in step)) {
			// The same claim as an ask's, on that very plan: the person's approve or reject and another agent's are
			// refused (`being_answered`) until this lands, and the approval goes only to the plan the answer was about.
			const claim = deps.claimPlan(tabId, step.planFile, step.planGeneration);
			if (claim === null)
				throw new Error(
					"That plan is not pending any more, or the plan changed since you read it, or another answer holds it: nothing was added to the session and nothing approved.",
				);
			try {
				let noted: { success: boolean; error?: string };
				try {
					noted = await send(note);
				} catch (error) {
					throw new Error(
						`no word came back about what goes with the answer (${error instanceof Error ? error.message : String(error)}): the attachments may have reached that session; the plan was not answered. Sending the same answer again is safe.`,
					);
				}
				if (!noted.success) throw failed(noted.error);
				if (!deps.planStillClaimed(tabId, claim))
					throw new Error(
						"The plan changed or was closed while the attachments were going in (its turn was aborted, or a new proposal replaced it): the attachments reached that session, and no approval was sent to any plan.",
					);
				const answered = await send(step.plan, true);
				if (!answered.success)
					throw new Error(
						`The plan was not answered (${answered.error ?? "no reason given"}); the attachments reached that session.`,
					);
				return;
			} finally {
				deps.releasePlan(tabId, claim);
			}
		}
		// Claim, then append, then resolve: from the tick that finds the question open no other answer can land. The one
		// thing outside main's hands is omp itself cancelling the question meanwhile (its turn aborted): then the note
		// is in and the answer cannot be, and that is said.
		const claim = deps.claim(tabId, step.askId);
		if (claim === null) throw gone;
		let noted: { success: boolean; error?: string };
		try {
			noted = await send(note);
		} catch (error) {
			// No answer from the target's omp (a timeout, a lost reply): the note may be in it. Nothing is claimed as
			// either way; the question opens again, and the same answer sent again adds the note at most once (the
			// bridge refuses a mail id it holds) and then answers.
			deps.release(step.askId, claim);
			throw new Error(
				`no word came back about what goes with the answer (${error instanceof Error ? error.message : String(error)}): the attachments may have reached that session; the answer was not sent. Sending the same answer again is safe.`,
			);
		}
		if (!noted.success) {
			deps.release(step.askId, claim);
			throw failed(noted.error);
		}
		if (!deps.askOpen(tabId, step.askId)) {
			deps.release(step.askId, claim);
			throw new Error(
				"The session cancelled the question while the attachments were going in (its turn was aborted): the attachments reached that session, the answer did not.",
			);
		}
		try {
			if (await deps.route(tabId, step.askId, step.response, claim)) return;
		} catch (error) {
			deps.release(step.askId, claim);
			throw new Error(
				`The answer was not delivered (${error instanceof Error ? error.message : String(error)}); the attachments reached that session. Sending the same answer again is safe.`,
			);
		}
		throw new Error(
			"The session cancelled the question while the attachments were going in (its turn was aborted): the attachments reached that session, the answer did not.",
		);
	}
}
