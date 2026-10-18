import { afterEach, describe, expect, it } from "vitest";
import { awaitedInput, createExtensionUiStore } from "../stores/extension-ui";
import { createPlanApprovalStore } from "../stores/plan-approval";
import { composerBlockedBy } from "./composer-blocked";

describe("composerBlockedBy", () => {
	it("names an approval before a question, and a question before a plan", () => {
		expect(composerBlockedBy("approval", true)).toBe("approval");
		expect(composerBlockedBy("input", true)).toBe("ask");
		expect(composerBlockedBy(null, true)).toBe("plan");
		expect(composerBlockedBy(null, false)).toBeNull();
	});
});

describe("composerBlockedBy over the stores that hold the cards", () => {
	const extension = createExtensionUiStore();
	const plan = createPlanApprovalStore();
	afterEach(() => {
		extension.setState({ pendingRequests: [], loginRequestIds: {} });
		plan.getState().clearProposal();
	});
	const blocked = () => composerBlockedBy(awaitedInput(extension.getState()), plan.getState().pending !== null);

	it("sees an ask card, a tool approval and a plan proposal, and nothing once they are answered", () => {
		expect(blocked()).toBeNull();

		extension.getState().pushRequest({
			type: "extension_ui_request",
			id: "q1",
			method: "input",
			title: "Which file?",
		});
		expect(blocked()).toBe("ask");
		extension.getState().removeRequest("q1");

		extension.getState().pushRequest({
			type: "extension_ui_request",
			id: "a1",
			method: "select",
			title: "Allow tool: bash\nrm -rf build",
			options: ["Approve", "Deny"],
		});
		expect(blocked()).toBe("approval");
		extension.getState().removeRequest("a1");

		plan.getState().showProposal({ planFilePath: "/tmp/plan.md", planContent: "# plan", options: ["execute"] });
		expect(blocked()).toBe("plan");
		plan.getState().clearProposal();
		expect(blocked()).toBeNull();
	});
});
