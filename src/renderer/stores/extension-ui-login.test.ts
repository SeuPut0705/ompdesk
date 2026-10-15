/**
 * A provider sign-in started from an OMPdesk panel owns the requests stock's
 * `login` sends while it runs, so none of them reaches the chat, and gets
 * them back when `login` answers: stock never closes the code paste it raced
 * against the callback (rpc-mode `login` gives its `input` no signal).
 */
import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { createExtensionUiStore } from "./extension-ui";

const question: ExtensionUIRequest = { type: "extension_ui_request", id: "q", method: "input", title: "Branch name?" };
const openUrl: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "url",
	method: "open_url",
	url: "https://claude.ai/oauth/authorize?state=xyz",
	launchUrl: "http://localhost:54545/launch",
};
const waiting: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "wait",
	method: "notify",
	message: "Waiting for browser authentication...",
	notifyType: "info",
};
const warning: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "warn",
	method: "notify",
	message: "Preferred port 54545 unavailable",
	notifyType: "warning",
};
const paste: ExtensionUIRequest = {
	type: "extension_ui_request",
	id: "paste",
	method: "input",
	title: "Paste the authorization code (or full redirect URL):",
	timeout: 600_000,
};

describe("inline sign-in routing", () => {
	it("owns what stock's login sends while it runs; a question already waiting and warnings stay the chat's", () => {
		const store = createExtensionUiStore();
		store.getState().pushRequest(question);
		store.getState().beginInlineLogin();
		for (const request of [openUrl, waiting, warning, paste]) store.getState().pushRequest(request);
		expect(Object.keys(store.getState().loginRequestIds).sort()).toEqual(["paste", "url", "wait"]);
		expect(store.getState().lastOpenUrlHost).toBe("claude.ai");
	});

	it("hands the leftovers back once the last sign-in answered, and forgets them", () => {
		const store = createExtensionUiStore();
		store.getState().pushRequest(question);
		store.getState().beginInlineLogin();
		store.getState().pushRequest(paste);
		store.getState().beginInlineLogin();
		store.getState().pushRequest({ ...paste, id: "paste-2" });
		// One sign-in still runs: its requests and the earlier one's stay owned.
		expect(store.getState().endInlineLogin()).toEqual([]);
		expect(store.getState().pendingRequests.map(request => request.id)).toEqual(["q", "paste", "paste-2"]);

		expect(
			store
				.getState()
				.endInlineLogin()
				.map(request => request.id),
		).toEqual(["paste", "paste-2"]);
		expect(store.getState().pendingRequests.map(request => request.id)).toEqual(["q"]);
		expect(Object.keys(store.getState().arrivedAt)).toEqual(["q"]);
		expect(store.getState().loginRequestIds).toEqual({});
		expect(store.getState().inlineLogins).toBe(0);
		// Afterwards a paste request is the chat's again (e.g. an MCP server's sign-in).
		store.getState().pushRequest({ ...paste, id: "mcp" });
		expect(store.getState().loginRequestIds).toEqual({});
	});

	it("keeps a sign-in running across a session reset of the queue", () => {
		const store = createExtensionUiStore();
		store.getState().beginInlineLogin();
		store.getState().pushRequest(paste);
		store.getState().clearAll();
		expect(store.getState().pendingRequests).toEqual([]);
		store.getState().pushRequest({ ...paste, id: "again" });
		expect(store.getState().loginRequestIds).toEqual({ again: true });
	});
});
