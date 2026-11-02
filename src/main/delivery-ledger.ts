/**
 * Exactly-once delivery of a person's message that crossed a link (a paired phone's page, a computer viewing this
 * one's tab): the sender names each message with a `deliveryId` and sends it again until it hears an answer, so a
 * message whose answer the link lost (it arrived, the answer did not) comes back with the same id. The first one
 * reaches omp; a repeat waits for that one's answer and gets it, and omp never sees a second copy.
 *
 * One ledger for the process, keyed by the sender's random id: every tab's omp on this computer shares it. Only an
 * accepted message is kept (a refusal or a lost omp can be tried again), the newest `KEPT` for `KEPT_MS`.
 */
import type { RpcResponse } from "../shared/rpc-types";

const KEPT = 2000;
const KEPT_MS = 24 * 60 * 60_000;

interface Entry {
	at: number;
	answer: Promise<RpcResponse>;
}

const entries = new Map<string, Entry>();

/** A message with this id has been delivered, or is on its way to omp. */
export function deliveryKnown(id: string): boolean {
	const entry = entries.get(id);
	return entry !== undefined && Date.now() - entry.at < KEPT_MS;
}

/** Run `send` once per `id`: a repeat gets the first one's answer while it is accepted or still on its way. */
export function deliverOnce(id: string, send: () => Promise<RpcResponse>): Promise<RpcResponse> {
	if (deliveryKnown(id)) {
		const known = entries.get(id);
		if (known) return known.answer;
	}
	const answer = send();
	entries.set(id, { at: Date.now(), answer });
	answer.then(
		response => {
			if (!response.success && entries.get(id)?.answer === answer) entries.delete(id);
		},
		() => {
			if (entries.get(id)?.answer === answer) entries.delete(id);
		},
	);
	while (entries.size > KEPT) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
	return answer;
}
