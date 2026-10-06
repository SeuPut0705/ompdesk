import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../locales/en";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { describeTurnError, retryLastTurn, type TurnErrorKind, turnErrorToast } from "./messages";

const KINDS: TurnErrorKind[] = [
	"aborted",
	"connection",
	"contextOverflow",
	"auth",
	"rateLimit",
	"overloaded",
	"compaction",
	"unknown",
];

describe("describeTurnError", () => {
	it.each<[string, TurnErrorKind]>([
		["Request was aborted", "aborted"],
		["AbortError: The operation was aborted.", "aborted"],
		["Unable to connect. Is the computer able to access the url?", "connection"],
		["connect ECONNREFUSED 127.0.0.1:11434", "connection"],
		["TypeError: fetch failed", "connection"],
		["getaddrinfo ENOTFOUND api.example.com", "connection"],
		["Request timed out after 300000ms", "connection"],
		["Prompt is too long: Provided 8,464 tokens, but the maximum allowed is 8,192.", "contextOverflow"],
		["This model's maximum context length is 128000 tokens.", "contextOverflow"],
		["input has too many tokens", "contextOverflow"],
		['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
		["Error: 403 Forbidden", "auth"],
		["Invalid API key provided", "auth"],
		["No API key found for anthropic", "auth"],
		["No models available. Use /login or set an API key environment variable.", "auth"],
		["No model selected", "auth"],
		["429 Too Many Requests", "rateLimit"],
		["Rate limit reached for requests per minute", "rateLimit"],
		["You exceeded your current quota, please check your plan and billing details.", "rateLimit"],
		['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
		["503 Service Unavailable", "overloaded"],
		["Compaction freed too little context (7.1k of 8.2k)", "compaction"],
		["Something unexpected happened", "unknown"],
	])("maps %j to %s", (raw, kind) => {
		expect(describeTurnError(raw).kind).toBe(kind);
	});

	it("treats a user stop as an abort whatever the text says", () => {
		expect(describeTurnError(undefined, "aborted").kind).toBe("aborted");
		expect(describeTurnError("socket hang up", "aborted").kind).toBe("aborted");
		expect(describeTurnError(undefined, "aborted").actions).toEqual([]);
	});

	it("does not read token counts as HTTP statuses", () => {
		expect(describeTurnError("Generated 8,403 tokens before stopping").kind).toBe("unknown");
	});

	it("keeps the raw provider text as the detail", () => {
		const raw = "  connect ECONNREFUSED 127.0.0.1:11434 ";
		expect(describeTurnError(raw).detail).toBe("connect ECONNREFUSED 127.0.0.1:11434");
		expect(describeTurnError(undefined).detail).toBe("");
	});

	it("offers the recovery that fits each kind, fixing action first", () => {
		expect(describeTurnError("Unable to connect").actions).toEqual(["retry", "openProviders"]);
		expect(describeTurnError("Prompt is too long").actions).toEqual(["compact", "changeModel"]);
		expect(describeTurnError("invalid x-api-key").actions).toEqual(["openProviders", "changeModel"]);
		expect(describeTurnError("429 Too Many Requests").actions).toEqual(["retry", "changeModel"]);
		expect(describeTurnError("Overloaded").actions).toEqual(["retry", "changeModel"]);
		expect(describeTurnError("Compaction freed too little context").actions[0]).toBe("changeModel");
		expect(describeTurnError("boom").actions).toEqual(["retry", "changeModel"]);
	});

	it("has a localized title and guidance for every kind", () => {
		const keys: Record<string, string> = en;
		for (const kind of KINDS) {
			expect(keys[`turnError.${kind}.title`], kind).toBeTruthy();
			expect(keys[`turnError.${kind}.guidance`], kind).toBeTruthy();
		}
		expect(describeTurnError(undefined, "aborted")).toMatchObject({
			titleKey: "turnError.aborted.title",
			guidanceKey: "turnError.aborted.guidance",
		});
	});
});

describe("turnErrorToast", () => {
	it("never surfaces raw provider English as the toast", () => {
		const toast = turnErrorToast("Unable to connect. Is the computer able to access the url?");
		expect(toast.kind).toBe("connection");
		expect(toast.title).toBe(en["turnError.connection.title"]);
		expect(toast.message).toBe(en["turnError.connection.guidance"]);
		expect(toast.title.split(/\s+/).length).toBeLessThanOrEqual(4);
	});
});

describe("retryLastTurn", () => {
	afterEach(() => {
		useMessagesStore.getState().reset();
		useSessionStore.getState().reset();
	});

	it("re-sends the last user prompt through the given tab rpc", async () => {
		useMessagesStore.setState({
			messages: [
				{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
				{ role: "assistant", content: [], errorMessage: "Unable to connect", timestamp: 2 },
				{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 },
			],
		});
		const rpc = {
			prompt: vi.fn(async () => ({ type: "response" as const, command: "prompt", success: true as const })),
			abortAndPrompt: vi.fn(async () => ({
				type: "response" as const,
				command: "abort_and_prompt",
				success: true as const,
			})),
		};
		const onEmpty = vi.fn();
		await retryLastTurn(onEmpty, rpc);
		expect(rpc.prompt).toHaveBeenCalledWith("second");
		expect(rpc.abortAndPrompt).not.toHaveBeenCalled();
		expect(onEmpty).not.toHaveBeenCalled();
	});

	it("reports an empty session instead of sending nothing", async () => {
		const rpc = { prompt: vi.fn(), abortAndPrompt: vi.fn() };
		const onEmpty = vi.fn();
		await retryLastTurn(onEmpty, rpc);
		expect(onEmpty).toHaveBeenCalledOnce();
		expect(rpc.prompt).not.toHaveBeenCalled();
	});
});
