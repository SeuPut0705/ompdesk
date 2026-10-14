import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { awaitedInput } from "./extension-ui";

const approval: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "approval",
	method: "select",
	title: "Allow tool: bash\nrm -rf build",
	options: ["Approve", "Deny"],
};
const ask: ExtensionUIRequest = { type: "extension_ui_request", id: "ask", method: "ask", questions: [] };
const signIn: ExtensionUIRequest = { type: "extension_ui_request", id: "url", method: "open_url", url: "https://x" };

describe("awaitedInput", () => {
	it("names a tool approval an approval and every other answer input", () => {
		expect(awaitedInput({ pendingRequests: [approval], inlineLogin: false })).toBe("approval");
		expect(awaitedInput({ pendingRequests: [ask], inlineLogin: false })).toBe("input");
		// A select that only looks like approval (other options) is a question.
		expect(awaitedInput({ pendingRequests: [{ ...approval, options: ["Yes", "No"] }], inlineLogin: false })).toBe(
			"input",
		);
	});

	it("follows the first blocking request, skipping a sign-in answered inline", () => {
		expect(awaitedInput({ pendingRequests: [ask, approval], inlineLogin: false })).toBe("input");
		expect(awaitedInput({ pendingRequests: [signIn, approval], inlineLogin: true })).toBe("approval");
		expect(awaitedInput({ pendingRequests: [signIn], inlineLogin: true })).toBeNull();
		expect(awaitedInput({ pendingRequests: [], inlineLogin: false })).toBeNull();
	});
});
