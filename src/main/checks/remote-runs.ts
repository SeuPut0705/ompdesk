/**
 * Checks the hub placed on a paired computer (design §5 policy 5): each `RemoteRun` goes over the link to that computer
 * as `checks.runLocal` and its answer back to the hub. A link that fails, an older computer's `unsupported`, a run that
 * could not start there or a reply that is no answer is told to the hub as `error`; the hub then runs the check on a
 * GitHub runner under the same id, so the session that waits for it is answered either way.
 */
import { type Answer, AnswerSchema, type LocalRunAsk, type RemoteRun } from "../../shared/checks-contract";

export interface RemoteRunsDeps {
	hub: {
		onRemoteRun(listener: (run: RemoteRun) => void): () => void;
		remoteAnswer(id: string, outcome: { answer: Answer } | { error: string }): Promise<void>;
	};
	/** `checks.runLocal` on that computer; resolves with its reply, as long as the run takes. */
	request(device: string, ask: LocalRunAsk): Promise<unknown>;
	log(message: string, details: Record<string, string | number | boolean>): void;
}

/** Relays every check placed on a paired computer from now on; returns the stop. */
export function relayRemoteRuns(deps: RemoteRunsDeps): () => void {
	return deps.hub.onRemoteRun(run => {
		deps
			.request(run.device, run.ask)
			.then(
				(reply): { answer: Answer } | { error: string } => {
					const parsed = AnswerSchema.safeParse(reply);
					return parsed.success ? { answer: parsed.data } : { error: `${run.device} answered no check result` };
				},
				(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
			)
			.then(outcome => deps.hub.remoteAnswer(run.id, outcome))
			// A hub that cannot take the answer (the core ended) lost the run with it: its wait ends unanswered.
			.catch(error =>
				deps.log("checks-remote-answer-failed", {
					run: run.id,
					device: run.device,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	});
}
