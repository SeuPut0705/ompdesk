/**
 * Prompt origins (A85; resources/gui-bridge/prompt-origin.ts and its
 * contracts): a host tab's omp journals its device once per user message, a
 * local tab journals nothing, and a transcript labels the prompts typed on
 * another device than the viewing one — only once the conversation holds
 * prompts from two devices or more.
 */
import { describe, expect, it } from "vitest";
import { install, methods, type PromptOriginHost } from "../../resources/gui-bridge/prompt-origin-core";
import {
	labelPromptOrigins,
	localizePromptOrigins,
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
		const appendedByLocal: unknown[] = [];
		const [onLocalEnd] = hooks(null);
		onLocalEnd!(
			{ message: { role: "user", timestamp: 9 } },
			{ sessionManager: { appendCustomEntry: (...entry: unknown[]) => appendedByLocal.push(entry) } },
		);
		expect(appendedByLocal).toEqual([]);
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

	it("journals the device main named for a prompt (`prompt_origin_set`), once, by its text, on a local tab", async () => {
		const env = {} as never;
		const handlers: Handler[] = [];
		const clock = 1_000;
		install({ on: (_event, handler) => handlers.push(handler) }, null, () => clock);
		const appended: [string, unknown][] = [];
		const ctx = {
			sessionManager: { appendCustomEntry: (type: string, data: unknown) => appended.push([type, data]) },
		};
		await methods.prompt_origin_set!({ origin: { deviceId: "dev-c", name: "Tablet C" }, text: "steer me" }, env);
		const [onEnd] = handlers;
		// A message nobody named is the host's: nothing journaled.
		onEnd!({ message: { role: "user", timestamp: 1, content: "typed on the host" } }, ctx);
		expect(appended).toEqual([]);
		// The named text, as a string or as text blocks, journals once.
		onEnd!({ message: { role: "user", timestamp: 2, content: [{ type: "text", text: "steer me" }] } }, ctx);
		onEnd!({ message: { role: "user", timestamp: 3, content: "steer me" } }, ctx);
		expect(appended).toEqual([[PROMPT_ORIGIN_ENTRY, { deviceId: "dev-c", name: "Tablet C", timestamp: 2 }]]);
	});

	it("names the device of a prompt in the order the prompts are sent, and lets a name expire unused", async () => {
		const env = {} as never;
		const handlers: Handler[] = [];
		let clock = Date.now();
		install({ on: (_event, handler) => handlers.push(handler) }, LAPTOP, () => clock);
		const appended: [string, { deviceId: string; timestamp: number }][] = [];
		const ctx = {
			sessionManager: {
				appendCustomEntry: (type: string, data: unknown) =>
					appended.push([type, data as { deviceId: string; timestamp: number }]),
			},
		};
		const [onEnd] = handlers;
		await methods.prompt_origin_set!({ origin: { deviceId: "dev-c", name: "Tablet C" }, text: "again" }, env);
		await methods.prompt_origin_set!({ origin: { deviceId: "dev-d", name: "Phone D" }, text: "again" }, env);
		onEnd!({ message: { role: "user", timestamp: 1, content: "again" } }, ctx);
		onEnd!({ message: { role: "user", timestamp: 2, content: "again" } }, ctx);
		// Past its life a name is gone; the tab's own device (this env) is what the message is.
		await methods.prompt_origin_set!({ origin: { deviceId: "dev-c", name: "Tablet C" }, text: "late" }, env);
		clock += 3 * 60 * 60_000;
		onEnd!({ message: { role: "user", timestamp: 3, content: "late" } }, ctx);
		expect(appended.map(([, entry]) => [entry.deviceId, entry.timestamp])).toEqual([
			["dev-c", 1],
			["dev-d", 2],
			["dev-a", 3],
		]);
	});

	it("refuses params that name no device or no text", async () => {
		const env = {} as never;
		await expect(
			methods.prompt_origin_set!({ origin: { deviceId: "", name: "x" }, text: "t" }, env),
		).rejects.toThrow();
		await expect(methods.prompt_origin_set!({ origin: { deviceId: "d", name: "x" } }, env)).rejects.toThrow();
	});
});

describe("prompt origin labels", () => {
	const messages = [user(1), reply(2), user(3), reply(4), user(5)];
	const entries = [tag(LAPTOP, 3), tag(TABLET, 5)];

	it("labels nothing while one device typed every prompt", () => {
		expect(labelPromptOrigins(messages, [], null)).toEqual(messages);
		expect(labelPromptOrigins([user(3)], entries, LAPTOP)).toEqual([user(3)]);
	});

	it("on a local tab, marks every prompt with who typed it and names the paired devices", () => {
		expect(labelPromptOrigins(messages, entries, null)).toEqual([
			{ ...user(1), promptFromId: "host" },
			reply(2),
			{ ...user(3), promptFrom: "Laptop A", promptFromId: "dev-a" },
			reply(4),
			{ ...user(5), promptFrom: "Tablet C", promptFromId: "dev-c" },
		]);
	});

	it("a window sees the other devices' prompts named, the host's by the host's name, and its own plain", () => {
		const labelled = labelPromptOrigins(messages, entries, null) as Array<{
			role: string;
			timestamp: number;
			promptFrom?: string;
			promptFromId?: string;
		}>;
		// The laptop's window.
		expect(localizePromptOrigins(labelled, "dev-a", "Host B")).toEqual([
			{ ...user(1), promptFrom: "Host B" },
			reply(2),
			user(3),
			reply(4),
			{ ...user(5), promptFrom: "Tablet C" },
		]);
		// A desktop window of the host itself.
		expect(localizePromptOrigins(labelled, "host", "Host B")).toEqual([
			user(1),
			reply(2),
			{ ...user(3), promptFrom: "Laptop A" },
			reply(4),
			{ ...user(5), promptFrom: "Tablet C" },
		]);
		// A page with no label is left as it is.
		expect(localizePromptOrigins([user(1)], "dev-a", "Host B")).toEqual([user(1)]);
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
