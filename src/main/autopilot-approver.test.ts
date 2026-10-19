import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../shared/rpc-types";
import { type ApproverRun, AutopilotApprover, decideApproval, decideQuestion } from "./autopilot-approver";

const approval = (text: string, id = "r1"): ExtensionUIRequest => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: `Allow tool: ${text}`,
	options: ["Approve", "Deny"],
});

const run = (over: Partial<ApproverRun> = {}): ApproverRun => ({
	role: "parent",
	root: "/wt/autopilot-1",
	ship: { autoPush: false, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "origin" },
	oneShotRelease: false,
	defaultBranch: "main",
	...over,
});

describe("decideApproval", () => {
	it("approves an ordinary card", () => {
		expect(decideApproval(approval("bash\nbun run check:changed"), run())).toEqual({ answer: "Approve" });
		expect(decideApproval(approval("edit\nsrc/a.ts"), run()).answer).toBe("Approve");
	});

	it("denies a card whose command breaks a hard limit, with the reason", () => {
		for (const command of [
			"git push --force origin main",
			"git reset --hard HEAD~3",
			"git branch -D main",
			"rm -rf /",
		]) {
			const decision = decideApproval(approval(`bash\n${command}`), run());
			expect(decision.answer, command).toBe("Deny");
			expect(decision.reason, command).toBeTruthy();
		}
	});

	it("denies a push in a local-only run and allows the same text only inside the release scope", () => {
		expect(decideApproval(approval("bash\ngit push origin HEAD:main"), run()).answer).toBe("Deny");
		expect(decideApproval(approval("bash\ngit push origin HEAD:main"), run({ oneShotRelease: true })).answer).toBe(
			"Approve",
		);
	});

	it("never opens the release scope for a child", () => {
		const child = run({ role: "child", oneShotRelease: true });
		expect(decideApproval(approval("bash\ngit push origin HEAD:main"), child).answer).toBe("Deny");
	});
});

describe("decideQuestion", () => {
	it("answers an ask with each question's recommended option and declines one without", () => {
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "q1",
			method: "ask",
			questions: [
				{ id: "a", question: "Which?", options: [{ label: "One" }, { label: "Two" }], recommended: 1 },
				{ id: "b", question: "Sure?", options: [{ label: "Yes" }] },
			],
		};
		expect(decideQuestion(request)).toEqual({
			type: "extension_ui_response",
			id: "q1",
			cancelled: true,
		});
		const first = { ...request, questions: request.questions.slice(0, 1) } as ExtensionUIRequest;
		expect(decideQuestion(first)).toEqual({
			type: "extension_ui_response",
			id: "q1",
			answers: [{ id: "a", selectedOptions: ["Two"] }],
		});
	});

	it("declines selects, confirms, inputs and editors", () => {
		for (const request of [
			{ type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["a", "b"] },
			{ type: "extension_ui_request", id: "c", method: "confirm", title: "Sure?", message: "m" },
			{ type: "extension_ui_request", id: "e", method: "editor", title: "Edit" },
		] as ExtensionUIRequest[]) {
			expect(decideQuestion(request)).toEqual({ type: "extension_ui_response", id: request.id, cancelled: true });
		}
	});
});

describe("AutopilotApprover", () => {
	function harness(runs: Record<string, ApproverRun>) {
		const answers: Array<{ tabId: string; response: ExtensionUIResponse }> = [];
		const approver = new AutopilotApprover({
			runOf: tabId => runs[tabId],
			answer: async (tabId, response) => {
				answers.push({ tabId, response });
			},
		});
		return { approver, answers };
	}

	it("answers the approval cards of an autopilot tab and leaves other tabs alone", async () => {
		const { approver, answers } = harness({ ap: run() });
		expect(approver.handle("ap", approval("bash\nls"))).toBe(true);
		expect(approver.handle("other", approval("bash\nls", "r2"))).toBe(false);
		await approver.idle();
		expect(answers).toEqual([
			{ tabId: "ap", response: { type: "extension_ui_response", id: "r1", value: "Approve" } },
		]);
	});

	it("answers stock's card with the session option for this call only, so every later call is checked again", async () => {
		const { approver, answers } = harness({ ap: run() });
		const card = { ...approval("bash\nls"), options: ["Approve", "Approve bash for this session", "Deny"] };
		expect(approver.handle("ap", card as ExtensionUIRequest)).toBe(true);
		await approver.idle();
		expect(answers[0]?.response).toEqual({ type: "extension_ui_response", id: "r1", value: "Approve" });
	});

	it("denies a violating card", async () => {
		const { approver, answers } = harness({ ap: run() });
		approver.handle("ap", approval("bash\ngit push --force origin x"));
		await approver.idle();
		expect(answers[0]?.response).toEqual({ type: "extension_ui_response", id: "r1", value: "Deny" });
	});

	it("answers a parent's remaining questions but leaves a child's to its parent", async () => {
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "q",
			method: "confirm",
			title: "Continue?",
			message: "m",
		};
		const { approver, answers } = harness({ parent: run(), child: run({ role: "child" }) });
		expect(approver.handle("parent", request)).toBe(true);
		expect(approver.handle("child", request)).toBe(false);
		await approver.idle();
		expect(answers.map(entry => entry.tabId)).toEqual(["parent"]);
	});

	it("leaves the control tools' own confirmation cards and sign-in traffic to the person", () => {
		const { approver, answers } = harness({ ap: run() });
		const card: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "k",
			method: "confirm",
			title: "[OMPdesk] Stop session?",
			message: "m",
		};
		expect(approver.handle("ap", card)).toBe(false);
		expect(
			approver.handle("ap", { type: "extension_ui_request", id: "u", method: "open_url", url: "https://x" }),
		).toBe(false);
		expect(approver.handle("ap", { type: "extension_ui_request", id: "n", method: "notify", message: "hi" })).toBe(
			false,
		);
		expect(answers).toEqual([]);
	});

	it("keeps going when an answer fails to send", async () => {
		const approver = new AutopilotApprover({
			runOf: () => run(),
			answer: async () => {
				throw new Error("gone");
			},
		});
		approver.handle("ap", approval("bash\nls"));
		await expect(approver.idle()).resolves.toBeUndefined();
	});
});
