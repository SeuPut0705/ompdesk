/**
 * Prompt origins (A85; resources/gui-bridge/prompt-origin.ts and its
 * contracts): a host tab's omp journals its device once per user message, a
 * local tab journals nothing, and a transcript labels the prompts typed on
 * another device than the viewing one — only once the conversation holds
 * prompts from two devices or more.
 */
import { describe, expect, it } from "vitest";
import { install, type PromptOriginHost } from "../../resources/gui-bridge/prompt-origin";
import {
	labelPromptOrigins,
	PROMPT_ORIGIN_ENTRY,
	type PromptOriginEnv,
	parsePromptOriginEnv,
} from "../../resources/gui-bridge/prompt-origin-contracts";

type Handler = Parameters<PromptOriginHost["on"]>[1];

const LAPTOP: PromptOriginEnv = { deviceId: "dev-a", name: "Laptop A", hostName: "Host B" };
const TABLET: PromptOriginEnv = { deviceId: "dev-c", name: "Tablet C", hostName: "Host B" };

function hooks(origin: PromptOriginEnv | null): Handler[] {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) }, origin);
	return handlers;
}

function tag(origin: PromptOriginEnv, timestamp: number) {
	return {
		type: "custom",
		customType: PROMPT_ORIGIN_ENTRY,
		data: { deviceId: origin.deviceId, name: origin.name, timestamp },
	};
}

const user = (timestamp: number) => ({ role: "user", timestamp });
const reply = (timestamp: number) => ({ role: "assistant", timestamp });

describe("prompt origin journal", () => {
	it("a host tab journals each user message's device by timestamp; other messages and local tabs journal nothing", () => {
		expect(hooks(null)).toEqual([]);
		const [onEnd] = hooks(LAPTOP);
		const appended: [string, unknown][] = [];
		const ctx = {
			sessionManager: { appendCustomEntry: (type: string, data: unknown) => appended.push([type, data]) },
		};
		onEnd!({ message: { role: "assistant", timestamp: 1 } }, ctx);
		onEnd!({ message: { role: "user" } }, ctx);
		onEnd!({ message: { role: "user", timestamp: 2 } }, ctx);
		expect(appended).toEqual([[PROMPT_ORIGIN_ENTRY, { deviceId: "dev-a", name: "Laptop A", timestamp: 2 }]]);
	});

	it("reads the spawn env and refuses anything malformed", () => {
		expect(parsePromptOriginEnv(JSON.stringify(LAPTOP))).toEqual(LAPTOP);
		expect(parsePromptOriginEnv(undefined)).toBeNull();
		expect(parsePromptOriginEnv("{")).toBeNull();
		expect(parsePromptOriginEnv(JSON.stringify({ deviceId: "dev-a", name: "", hostName: "B" }))).toBeNull();
		expect(parsePromptOriginEnv(JSON.stringify({ deviceId: "dev-a", name: "A" }))).toBeNull();
	});
});

describe("prompt origin labels", () => {
	const messages = [user(1), reply(2), user(3), reply(4), user(5)];
	const entries = [tag(LAPTOP, 3), tag(TABLET, 5)];

	it("labels nothing while one device typed every prompt", () => {
		expect(labelPromptOrigins(messages, [], null)).toEqual(messages);
		expect(labelPromptOrigins([user(3)], entries, LAPTOP)).toEqual([user(3)]);
	});

	it("on the host's own tab, labels the paired devices' prompts", () => {
		expect(labelPromptOrigins(messages, entries, null)).toEqual([
			user(1),
			reply(2),
			{ ...user(3), promptFrom: "Laptop A" },
			reply(4),
			{ ...user(5), promptFrom: "Tablet C" },
		]);
	});

	it("on a device's tab, labels the host's and the other devices' prompts, never its own", () => {
		expect(labelPromptOrigins(messages, entries, LAPTOP)).toEqual([
			{ ...user(1), promptFrom: "Host B" },
			reply(2),
			user(3),
			reply(4),
			{ ...user(5), promptFrom: "Tablet C" },
		]);
	});
});
