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
	const claims = new Map<string, number>();
	let serial = 0;
	const appended: string[] = [];
	const answered: string[] = [];
	/** The plan file of the pending proposal, and of the proposal the claim took. */
	const planFile = { current: "/p/plan-1.md", generation: 1 };
	const planObject = { current: 0 };
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
		claimPlan: (_tab, file, generation) => {
			if (!open.has("plan") || file !== planFile.current || generation !== planFile.generation || claims.has("plan"))
				return null;
			claims.set("plan", ++serial);
			planObject.current = planFile.generation;
			return claims.get("plan") ?? null;
		},
		planStillClaimed: (_tab, claim) =>
			claims.get("plan") === claim && open.has("plan") && planObject.current === planFile.generation,
		releasePlan: (_tab, claim) => {
			if (claims.get("plan") === claim) claims.delete("plan");
		},
		claim: (_tab, id) => {
			if (!open.has(id) || claims.has(id)) return null;
			const claim = ++serial;
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
	/** The person's approve or reject of the plan: refused while an agent's approval holds it. */
	const personApprovesPlan = () => {
		if (claims.has("plan")) return "being_answered";
		if (!open.has("plan")) return "gone";
		open.delete("plan");
		answered.push("person:plan");
		return "answered";
	};
	return {
		planFile,
		personApprovesPlan,
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
			{
				requestId: "answer-1|plan",
				companion,
				plan: { type: "plan_approval", approved: false } as RpcCommand,
				planFile: "/p/plan-1.md",
				planGeneration: 1,
			},
			t.send,
		);
		expect(t.appended).toEqual(["answer-1"]);
		expect(t.answered).toEqual(["plan_approval"]);
	});

	describe("a plan approval", () => {
		const plan: AnswerStep = {
			requestId: "answer-1|plan",
			companion,
			plan: { type: "plan_approval", approved: true } as RpcCommand,
			planFile: "/p/plan-1.md",
			planGeneration: 1,
		};

		it("refuses the person's approval while the note goes in, then approves that plan once", async () => {
			const t = target({ open: ["plan"] });
			let during = "";
			t.send.mockImplementationOnce(async command => {
				during = t.personApprovesPlan();
				if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
				return { success: true };
			});
			await t.answers.run("tab", plan, t.send);
			expect(during).toBe("being_answered");
			expect(t.appended).toEqual(["answer-1"]);
			expect(t.answered).toEqual(["plan_approval"]);
			expect(t.claims.size).toBe(0);
		});

		it("sends no approval to a replacement plan, and says the attachments arrived", async () => {
			const t = target({ open: ["plan"] });
			t.send.mockImplementationOnce(async command => {
				t.planFile.current = "/p/plan-2.md";
				t.planFile.generation = 2;
				if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
				return { success: true };
			});
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(
				/plan changed or was closed.*the attachments reached that session, and no approval was sent to any plan/,
			);
			expect(t.answered).toEqual([]);
			expect(t.claims.size).toBe(0);
		});

		it("refuses a revised proposal that reuses the plan file, between the snapshot and the claim", async () => {
			const t = target({ open: ["plan"] });
			t.planFile.generation = 2;
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(/the plan changed since you read it/);
			expect(t.send).not.toHaveBeenCalled();
			expect(t.appended).toEqual([]);
			expect(t.answered).toEqual([]);
		});

		it("sends no approval to a revised proposal that reuses the plan file while the note goes in", async () => {
			const t = target({ open: ["plan"] });
			t.send.mockImplementationOnce(async command => {
				t.planFile.generation = 2;
				if (command.type === "agent_control_mail") t.appended.push(String(command.details.id));
				return { success: true };
			});
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(/no approval was sent to any plan/);
			expect(t.answered).toEqual([]);
		});

		it("says so when the plan is closed meanwhile", async () => {
			const t = target({ open: ["plan"] });
			t.send.mockImplementationOnce(async () => {
				t.open.delete("plan");
				return { success: true };
			});
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(/plan changed or was closed/);
			expect(t.answered).toEqual([]);
		});

		it("refuses a plan that is not the one named, and one already held", async () => {
			const t = target({ open: ["plan"] });
			t.planFile.current = "/p/plan-2.md";
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(
				/not pending any more, or the plan changed since you read it/,
			);
			expect(t.send).not.toHaveBeenCalled();
		});

		it("releases the claim when the note fails, so the person can still approve", async () => {
			const t = target({ open: ["plan"], noteFails: true });
			await expect(t.answers.run("tab", plan, t.send)).rejects.toThrow(/Neither the attachments nor the answer/);
			expect(t.personApprovesPlan()).toBe("answered");
		});

		it("answers two revisions that share a title and files: each has its own key, so neither is taken for the other's replay", async () => {
			const t = target({ open: ["plan"] });
			const step = (generation: number): AnswerStep => ({
				requestId: `answer-${generation}|plan:${generation}`,
				companion: { ...companion, details: { id: `answer-${generation}` } },
				plan: { type: "plan_approval", approved: true } as RpcCommand,
				planFile: "/p/plan-1.md",
				planGeneration: generation,
			});
			await t.answers.run("tab", step(1), t.send);
			t.planFile.generation = 2;
			await t.answers.run("tab", step(2), t.send);
			expect(t.appended).toEqual(["answer-1", "answer-2"]);
			expect(t.answered).toEqual(["plan_approval", "plan_approval"]);
		});
	});
});
