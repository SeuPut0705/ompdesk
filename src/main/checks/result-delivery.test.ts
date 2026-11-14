import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleAnswer } from "../../shared/checks-fixture";
import type { ChecksDelivery } from "./client";
import { type ChecksMailReceipt, type ChecksResultMail, connectChecksResults } from "./result-delivery";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const delivery: ChecksDelivery = {
	deliveryId: "checks:instance-one:entry-1:result",
	result: {
		runId: "entry-1",
		origin: { kind: "session", session: "saved-one", device: "paired-device" },
		answer: sampleAnswer(),
	},
};

function source() {
	let listener: ((item: ChecksDelivery) => void) | null = null;
	const waiting = new Map<string, Set<(value: "ack" | "retained") => void>>();
	function finish(id: string, value: "ack" | "retained") {
		for (const resolve of waiting.get(id) ?? []) resolve(value);
		waiting.delete(id);
	}
	const acknowledged: string[] = [];
	return {
		acknowledged,
		onDelivery(receive: (item: ChecksDelivery) => void) {
			listener = receive;
			return () => {
				listener = null;
			};
		},
		async ackResult(id: string) {
			acknowledged.push(id);
			finish(id, "ack");
		},
		report(id: string) {
			finish(id, "retained");
		},
		async emit(item = delivery) {
			const outcome = Promise.withResolvers<"ack" | "retained">();
			let listeners = waiting.get(item.deliveryId);
			if (!listeners) {
				listeners = new Set();
				waiting.set(item.deliveryId, listeners);
			}
			listeners.add(outcome.resolve);
			if (!listener) throw new Error("source has no subscriber");
			listener(item);
			const result = await outcome.promise;
			await Promise.resolve();
			await Promise.resolve();
			return result;
		},
	};
}

describe("checks result responsibility transfer", () => {
	it("retains source delivery on memory acceptance, a save error, or an unrelated receipt", async () => {
		for (const outcome of ["memory", "error", "wrong-id"] as const) {
			const hub = source();
			const close = connectChecksResults(
				hub,
				async mail => {
					if (outcome === "error") throw new Error("ENOSPC");
					return {
						deliveryId: outcome === "wrong-id" ? "some-other-result" : mail.deliveryId,
						persistence: outcome === "memory" ? "memory" : "disk",
					};
				},
				hub.report,
			);
			expect(await hub.emit()).toBe("retained");
			expect(hub.acknowledged).toEqual([]);
			close();
		}
	});

	it("replays the same receiver journal id after persist/send/ACK response loss without a second effect", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checks-delivery-"));
		dirs.push(dir);
		const journal = path.join(dir, "receiver.json");
		let loseReply = true;
		const receive = async (mail: ChecksResultMail): Promise<ChecksMailReceipt> => {
			const entries: Record<string, string> = fs.existsSync(journal)
				? JSON.parse(fs.readFileSync(journal, "utf8"))
				: {};
			if (!entries[mail.deliveryId]) {
				entries[mail.deliveryId] = mail.text;
				fs.writeFileSync(journal, JSON.stringify(entries));
			}
			if (loseReply) throw new Error("receiver accepted on disk, but response was lost");
			return { deliveryId: mail.deliveryId, persistence: "disk" };
		};
		const beforeCrash = source();
		const stop = connectChecksResults(beforeCrash, receive, beforeCrash.report);
		expect(await beforeCrash.emit()).toBe("retained");
		expect(beforeCrash.acknowledged).toEqual([]);
		stop();
		loseReply = false;
		const reopened = source();
		const close = connectChecksResults(reopened, receive, reopened.report);
		expect(await reopened.emit()).toBe("ack");
		// A source whose ACK reply was lost can deliver again. The receiver still owns only one journal entry.
		expect(await reopened.emit()).toBe("ack");
		expect(Object.keys(JSON.parse(fs.readFileSync(journal, "utf8")))).toEqual([delivery.deliveryId]);
		expect(reopened.acknowledged).toEqual([delivery.deliveryId, delivery.deliveryId]);
		close();
	});

	it("keeps unconfirmed and final phases distinct and joins concurrent replay while acceptance is pending", async () => {
		const accepted = Promise.withResolvers<ChecksMailReceipt>();
		const hub = source();
		const received: string[] = [];
		const close = connectChecksResults(
			hub,
			mail => {
				received.push(mail.deliveryId);
				return received.length === 1
					? accepted.promise
					: Promise.resolve({ deliveryId: mail.deliveryId, persistence: "disk" });
			},
			hub.report,
		);
		const first = hub.emit();
		const duplicate = hub.emit();
		expect(received).toEqual([delivery.deliveryId]);
		accepted.resolve({ deliveryId: delivery.deliveryId, persistence: "disk" });
		await Promise.all([first, duplicate]);
		expect(await hub.emit({ ...delivery, deliveryId: "checks:instance-one:entry-1:unconfirmed" })).toBe("ack");
		expect(received).toEqual([delivery.deliveryId, "checks:instance-one:entry-1:unconfirmed"]);
		close();
	});
});
