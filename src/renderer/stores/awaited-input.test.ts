import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { awaitedInput, claimsLoginRequest, isUserBlockingRequest } from "./extension-ui";

const approval: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "approval",
	method: "select",
	title: "Allow tool: bash\nrm -rf build",
	options: ["Approve", "Deny"],
};
const ask: ExtensionUIRequest = { type: "extension_ui_request", id: "ask", method: "ask", questions: [] };
const signIn: ExtensionUIRequest = { type: "extension_ui_request", id: "url", method: "open_url", url: "https://x" };
const paste: ExtensionUIRequest = { type: "extension_ui_request", id: "key", method: "input", title: "Paste" };
const notice: ExtensionUIRequest = { type: "extension_ui_request", id: "n", method: "notify", message: "hi" };

describe("awaitedInput", () => {
	it("names a tool approval an approval and every other answer input", () => {
		expect(awaitedInput({ pendingRequests: [approval], loginRequestIds: {} })).toBe("approval");
		expect(awaitedInput({ pendingRequests: [ask], loginRequestIds: {} })).toBe("input");
		// A select that only looks like approval (other options) is a question.
		expect(awaitedInput({ pendingRequests: [{ ...approval, options: ["Yes", "No"] }], loginRequestIds: {} })).toBe(
			"input",
		);
	});

	it("follows the first blocking request, skipping a sign-in's own requests", () => {
		expect(awaitedInput({ pendingRequests: [ask, approval], loginRequestIds: {} })).toBe("input");
		expect(awaitedInput({ pendingRequests: [signIn, approval], loginRequestIds: { url: true } })).toBe("approval");
		expect(awaitedInput({ pendingRequests: [signIn], loginRequestIds: { url: true } })).toBeNull();
		expect(awaitedInput({ pendingRequests: [], loginRequestIds: {} })).toBeNull();
	});
});

describe("isUserBlockingRequest", () => {
	it("is true for a response-bearing request that is not a sign-in's own", () => {
		expect(isUserBlockingRequest({ loginRequestIds: {} }, ask)).toBe(true);
		expect(isUserBlockingRequest({ loginRequestIds: {} }, approval)).toBe(true);
		expect(isUserBlockingRequest({ loginRequestIds: {} }, signIn)).toBe(true);
		expect(isUserBlockingRequest({ loginRequestIds: { other: true } }, signIn)).toBe(true);
		expect(isUserBlockingRequest({ loginRequestIds: {} }, notice)).toBe(false);
	});

	it("is false for a request a sign-in recorded as its own", () => {
		expect(isUserBlockingRequest({ loginRequestIds: { url: true } }, signIn)).toBe(false);
		expect(isUserBlockingRequest({ loginRequestIds: { url: true } }, ask)).toBe(true);
	});
});

describe("claimsLoginRequest", () => {
	it("claims the kinds stock's login sends only while a sign-in is in flight", () => {
		expect(claimsLoginRequest({ inlineLogins: 1 }, signIn)).toBe(true);
		expect(claimsLoginRequest({ inlineLogins: 1 }, paste)).toBe(true);
		expect(claimsLoginRequest({ inlineLogins: 0 }, signIn)).toBe(false);
		expect(claimsLoginRequest({ inlineLogins: 1 }, ask)).toBe(false);
		expect(claimsLoginRequest({ inlineLogins: 1 }, approval)).toBe(false);
	});
});
