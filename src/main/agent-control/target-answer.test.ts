import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIResponse, RpcCommand } from "../../shared/rpc-types";
import { type AnswerStep, TargetAnswer } from "./target-answer";

const companion = {
	content: "What goes with my answer (the answer follows):",
	details: { id: "answer-1" },
	delivery: { triggerTurn: false },
};
const response = { type: "extension_ui_response", id: "r1", value: "Blue" } as ExtensionUIResponse;
const ask: AnswerStep = { requestId: "answer-1|r1", companion, askId: "r1", response };

/** A target: its questions and claims, what its bridge appended (deduped by the note's id, as the bridge does), and what it answered. */
function target(options: { open?: string[]; routeFails?: boolean; noteFails?: boolean } = {}) {
	const open = new Set(options.open ?? ["r1"]);
	const claims = new Map<string, symbol>();
	const appended: string[] = [];
	const answered: string[] = [];
	let routeFails = options.routeFails ?? false;
	const send = vi.fn(async (command: RpcCommand) => {
		if (command.type === "agent_control_mail") {
			if (options.noteFails) return { success: false, error: "its omp is starting" };
			const id = String(command.details.id);
			if (!appended.includes(id)) appended.push(id);
			return { success: true };
		}
		answered.push(command.type);
		return { success: true };
	});
	const answers = new TargetAnswer({
		askOpen: (_tab, id) => open.has(id),
		planOpen: () => open.has("plan"),
		claim: (_tab, id) => {
			if (!open.has(id) || claims.has(id)) return null;
			const claim = Symbol(id);
			claims.set(id, claim);
			return claim;
		},
		release: (id, claim) => {
			if (claims.get(id) === claim) claims.delete(id);
		},
		route: async (_tab, id, _response, claim) => {
			try {
				if (routeFails) throw new Error("The device running this tab is offline");
				if (!open.has(id)) return false;
				open.delete(id);
				answered.push(id);
				return true;
			} finally {
				if (claims.get(id) === claim) claims.delete(id);
			}
		},
	});
	/** The person's click on the card: refused while an agent's answer holds the question. */
	const personAnswers = (id: string) => {
		if (claims.has(id)) return "being_answered";
		if (!open.has(id)) return "gone";
		open.delete(id);
		answered.push(`person:${id}`);
		return "answered";
	};
	return {
		answers,
		send,
		open,
		claims,
		appended,
		answered,
		personAnswers,
		heal: () => {
			routeFails = false;
		},
	};
}

describe("an answer with attachments is one step on the answered session's computer", () => {
	it("appends the note, then answers", async () => {
		const t = target();
		await t.answers.run("tab", ask, t.send);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["r1"]);
	});

	it("refuses a question that is not open and appends nothing", async () => {
		const t = target({ open: [] });
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(
			/not open any more, or another answer holds it: nothing was added/,
		);
		expect(t.send).not.toHaveBeenCalled();
		expect(t.appended).toEqual([]);
	});

	it("appends nothing when the note cannot be delivered, and does not answer", async () => {
		const t = target({ noteFails: true });
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(
			/Neither the attachments nor the answer were sent/,
		);
		expect(t.answered).toEqual([]);
		expect(t.open.has("r1")).toBe(true);
	});

	it("refuses the person's answer while the note goes in, then the agent's answer and note land once", async () => {
		const t = target();
		let during = "";
		t.send.mockImplementationOnce(async command => {
			during = t.personAnswers("r1");
			if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
			return { success: true };
		});
		await t.answers.run("tab", ask, t.send);
		expect(during).toBe("being_answered");
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["r1"]);
	});

	it("releases the claim when the note fails, so the person can still answer", async () => {
		const t = target({ noteFails: true });
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(/Neither the attachments nor the answer/);
		expect(t.claims.size).toBe(0);
		expect(t.personAnswers("r1")).toBe("answered");
	});

	it("says explicitly that the attachments arrived and the answer did not when omp cancels the question meanwhile", async () => {
		const t = target();
		t.send.mockImplementationOnce(async command => {
			t.open.delete("r1");
			if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
			return { success: true };
		});
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(
			/the attachments reached that session, the answer did not/,
		);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual([]);
		expect(t.claims.size).toBe(0);
	});

	it("a transport that fails after the note leaves it appended once, and the resend answers without appending twice", async () => {
		const t = target({ routeFails: true });
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(/answer was not delivered/);
		expect(t.appended).toEqual(["answer-1"]);
		t.heal();
		await t.answers.run("tab", ask, t.send);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["r1"]);
	});

	it("a note whose reply is lost may be in: says so, never 'not sent', and the resend appends it at most once", async () => {
		const t = target();
		t.send.mockImplementationOnce(async command => {
			if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
			throw new Error("ompdesk-core did not answer in time");
		});
		await expect(t.answers.run("tab", ask, t.send)).rejects.toThrow(
			/the attachments may have reached that session; the answer was not sent\. Sending the same answer again is safe/,
		);
		expect(t.answered).toEqual([]);
		expect(t.claims.size).toBe(0);
		await t.answers.run("tab", ask, t.send);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["r1"]);
	});

	it("a resend after a lost reply does nothing more", async () => {
		const t = target();
		await t.answers.run("tab", ask, t.send);
		await t.answers.run("tab", ask, t.send);
		expect(t.send).toHaveBeenCalledTimes(1);
		expect(t.answered).toEqual(["r1"]);
	});

	it("a resend while the first is still running joins it", async () => {
		const t = target();
		await Promise.all([t.answers.run("tab", ask, t.send), t.answers.run("tab", ask, t.send)]);
		expect(t.send).toHaveBeenCalledTimes(1);
		expect(t.answered).toEqual(["r1"]);
	});

	it("answers a plan with the plan card's own command", async () => {
		const t = target({ open: ["plan"] });
		await t.answers.run(
			"tab",
			{ requestId: "answer-1|plan", companion, plan: { type: "plan_approval", approved: false } as RpcCommand },
			t.send,
		);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["plan_approval"]);
	});
});
