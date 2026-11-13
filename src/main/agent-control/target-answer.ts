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
 * - A question that closes between the check and the answer (its person answered in that moment) is said so: the note
 *   reached the session, the answer did not. Nothing in stock can hold a question open while a note goes in.
 */
import type { ExtensionUIResponse, RpcCommand } from "../../shared/rpc-types";

export interface AnswerCompanion {
	content: string | { type: string; [key: string]: unknown }[];
	details: Record<string, unknown>;
	delivery: { triggerTurn: boolean; deliverAs?: "aside" };
}

export type AnswerStep = { requestId: string; companion: AnswerCompanion } & (
	| { askId: string; response: ExtensionUIResponse }
	| { plan: RpcCommand }
);

export interface TargetAnswerDeps {
	/** Whether the question `id` is still open on `tabId`. */
	askOpen(tabId: string, id: string): boolean;
	/** Whether `tabId` waits on a plan approval. */
	planOpen(tabId: string): boolean;
	/** Put the answer to the question to its omp; false when the question is no longer open. */
	route(tabId: string, id: string, response: ExtensionUIResponse): Promise<boolean>;
}

/** A command to the answered session's omp, through the dispatcher of the call. */
export type SendCommand = (command: RpcCommand) => Promise<{ success: boolean; error?: string }>;

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
		const open = "askId" in step ? deps.askOpen(tabId, step.askId) : deps.planOpen(tabId);
		if (!open) throw new Error("That question is not open any more: nothing was added to the session and nothing answered.");
		const { content, details, delivery } = step.companion;
		const noted = await send({
			type: "agent_control_mail",
			content,
			details,
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}),
		} as RpcCommand);
		if (!noted.success)
			throw new Error(
				`what goes with the answer could not be delivered (${noted.error ?? "no reason given"}). Neither the attachments nor the answer were sent.`,
			);
		const closed =
			"The question closed while the attachments were going in (it was answered, or its session moved on): the attachments reached that session, the answer did not.";
		if ("askId" in step) {
			// Stock sends nothing back for an answer to a question that is gone, so the claim is looked at again here.
			if (!deps.askOpen(tabId, step.askId)) throw new Error(closed);
			let routed = false;
			try {
				routed = await deps.route(tabId, step.askId, step.response);
			} catch (error) {
				throw new Error(
					`The answer was not delivered (${error instanceof Error ? error.message : String(error)}); the attachments reached that session. Sending the same answer again is safe.`,
				);
			}
			if (!routed) throw new Error(closed);
			return;
		}
		const answered = await send(step.plan);
		if (!answered.success)
			throw new Error(
				`The plan was not answered (${answered.error ?? "no reason given"}); the attachments reached that session.`,
			);
	}
}
