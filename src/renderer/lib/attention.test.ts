import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { boardCounts } from "../components/layout/work-board/work-board";
import { type AttentionState, pendingAsks, sessionAttention } from "./attention";

const approval: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "approval",
	method: "select",
	title: "Allow tool: bash\nrm -rf build",
	options: ["Approve", "Deny"],
};
const ask: ExtensionUIRequest = { type: "extension_ui_request", id: "ask", method: "ask", questions: [] };
const signIn: ExtensionUIRequest = { type: "extension_ui_request", id: "url", method: "open_url", url: "https://x" };
const notice: ExtensionUIRequest = { type: "extension_ui_request", id: "n", method: "notify", message: "hi" };

const none: AttentionState = { asks: [], childrenWaiting: 0 };

describe("sessionAttention", () => {
	it("is null when nothing needs the person", () => {
		expect(sessionAttention(none)).toBeNull();
	});

	it("names each kind on its own", () => {
		expect(sessionAttention({ ...none, asks: ["question"] })).toEqual({ kind: "question", count: 1 });
		expect(sessionAttention({ ...none, asks: ["approval"] })).toEqual({ kind: "approval", count: 1 });
		expect(sessionAttention({ ...none, childrenWaiting: 2 })).toEqual({ kind: "childWaiting", count: 2 });
	});

	it("says the session's first prompt before a waiting child", () => {
		expect(sessionAttention({ asks: ["approval", "question"], childrenWaiting: 1 })?.kind).toBe("approval");
		expect(sessionAttention({ asks: ["question", "approval"], childrenWaiting: 0 })?.kind).toBe("question");
		expect(sessionAttention({ asks: [], childrenWaiting: 1 })?.kind).toBe("childWaiting");
	});

	it("counts what the board's Needs you counts", () => {
		const cases: AttentionState[] = [
			none,
			{ asks: ["question"], childrenWaiting: 0 },
			{ asks: ["approval", "question"], childrenWaiting: 3 },
		];
		for (const state of cases) {
			const counts = boardCounts({
				asks: state.asks,
				childrenWaiting: state.childrenWaiting,
				childrenRunning: 2,
				agents: 1,
				agentsWorking: 1,
				jobs: 0,
				turnWorking: true,
			});
			expect(sessionAttention(state)?.count ?? 0).toBe(counts.needs);
		}
	});
});

describe("pendingAsks", () => {
	it("lists the blocking requests in order, a sign-in's own and notices left out, then a plan review", () => {
		expect(pendingAsks({ pendingRequests: [ask, notice, approval], loginRequestIds: {} }, false)).toEqual([
			"question",
			"approval",
		]);
		expect(pendingAsks({ pendingRequests: [signIn, ask], loginRequestIds: { url: true } }, true)).toEqual([
			"question",
			"approval",
		]);
		// A select that only looks like an approval (other options) is a question.
		expect(
			pendingAsks({ pendingRequests: [{ ...approval, options: ["Yes", "No"] }], loginRequestIds: {} }, false),
		).toEqual(["question"]);
	});
});
