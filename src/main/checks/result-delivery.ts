import type { Origin } from "../../shared/checks-contract";
import type { ChecksDelivery, CoreChecksHub } from "./client";

export interface ChecksResultMail {
	origin: Extract<Origin, { kind: "session" }>;
	deliveryId: string;
	fromTitle: string;
	text: string;
}

export interface ChecksMailReceipt {
	deliveryId: string;
	persistence: "disk" | "memory";
}

/** Source replay and the receiver's stable journal id cover crashes; this set only joins concurrent deliveries. */
export function connectChecksResults(
	hub: Pick<CoreChecksHub, "onDelivery" | "ackResult">,
	enqueue: (mail: ChecksResultMail) => Promise<ChecksMailReceipt>,
	report: (deliveryId: string, error: unknown) => void,
): () => void {
	const active = new Set<string>();
	return hub.onDelivery(delivery => {
		const { deliveryId, result } = delivery;
		if (result.origin.kind !== "session" || active.has(deliveryId)) return;
		active.add(deliveryId);
		void send(delivery)
			.catch(error => report(deliveryId, error))
			.finally(() => active.delete(deliveryId));
	});

	async function send({ deliveryId, result }: ChecksDelivery): Promise<void> {
		if (result.origin.kind !== "session") return;
		const receipt = await enqueue({
			origin: result.origin,
			deliveryId,
			fromTitle: "OMPdesk checks",
			text: `Check result ${result.runId}\n${JSON.stringify(result.answer)}`,
		});
		if (receipt.deliveryId !== deliveryId) throw new Error("The checks inbox accepted a different delivery id.");
		if (receipt.persistence !== "disk")
			throw new Error("The checks inbox is memory-only; the source retains this delivery.");
		await hub.ackResult(deliveryId);
	}
}
