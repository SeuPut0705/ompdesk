/**
 * The core numbers the questions it asks main from 1 at every start, so an answer sent after the core restarted could
 * settle another question. Each place that answers one hands the answer only to the core that asked: the generation of
 * the event goes with the call (`CoreCallOptions.generation`, fenced in `process.ts`; `process.test.ts`). The core is a
 * fake that records its calls here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerAsks } from "../ai-memory/core-asks";
import { servePull } from "../ai-memory/sync";
import { registerAsker } from "../remote/bytes-asks";
import { MobileWebService } from "../tailscale/service";

type Listener = (data: unknown, bin: Uint8Array | null, generation: number) => void;

const fake = vi.hoisted(() => ({
	calls: [] as Array<{ method: string; params: unknown; options: unknown }>,
	listeners: new Map<string, Array<(data: unknown, bin: Uint8Array | null, generation: number) => void>>(),
}));

vi.mock("./process", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	core: () => ({
		generation: 1,
		on: (event: string, listener: Listener) => {
			const listeners = fake.listeners.get(event) ?? [];
			listeners.push(listener);
			fake.listeners.set(event, listeners);
			return () =>
				fake.listeners.set(
					event,
					(fake.listeners.get(event) ?? []).filter(known => known !== listener),
				);
		},
		call: async (method: string, params: unknown, options: unknown) => {
			fake.calls.push({ method, params, options });
			return { result: {}, bin: null, generation: 1 };
		},
		push: () => undefined,
	}),
}));

/** The core of `generation` asks. */
function ask(event: string, data: object, generation: number): void {
	for (const listener of fake.listeners.get(event) ?? []) listener(data, null, generation);
}

const answerTo = (method: string) => fake.calls.find(call => call.method === method);

beforeEach(() => {
	fake.calls.length = 0;
});

describe("an answer to the core's question", () => {
	it("goes to the core that asked: remote bytes", async () => {
		const asker = registerAsker(async question => ({ echoed: question.kind }));
		ask("remotebytes.ask", { call: 4, asker: asker.id, kind: "page" }, 7);
		await vi.waitFor(() => expect(answerTo("remotebytes.answer")).toBeDefined());
		expect(answerTo("remotebytes.answer")).toEqual({
			method: "remotebytes.answer",
			params: { call: 4, result: { echoed: "page" } },
			options: { generation: 7 },
		});
		asker.release();
	});

	it("goes to the core that asked: a refused remote bytes question", async () => {
		ask("remotebytes.ask", { call: 5, asker: 999, kind: "page" }, 3);
		await vi.waitFor(() => expect(answerTo("remotebytes.answer")).toBeDefined());
		expect(answerTo("remotebytes.answer")).toMatchObject({
			params: { call: 5, failed: true },
			options: { generation: 3 },
		});
	});

	it("goes to the core that asked: memory sync", async () => {
		await servePull({ server: () => null, selfId: () => "me" } as never, "peer", {} as never);
		fake.calls.length = 0;
		ask("memsync.ask", { call: 3, kind: "redact", texts: ["a"] }, 5);
		await vi.waitFor(() => expect(answerTo("memsync.answer")).toBeDefined());
		expect(answerTo("memsync.answer")).toMatchObject({ params: { call: 3 }, options: { generation: 5 } });
	});

	it("goes to the core that asked: the memory services' upkeep", async () => {
		const stop = answerAsks("svc", { echo: async params => params });
		ask("upkeep.ask", { service: "svc", ask: 2, kind: "echo", params: 9 }, 4);
		await vi.waitFor(() => expect(answerTo("upkeep.answer")).toBeDefined());
		expect(answerTo("upkeep.answer")).toEqual({
			method: "upkeep.answer",
			params: { ask: 2, ok: true, value: 9 },
			options: { generation: 4 },
		});
		stop();
	});

	it("goes to the core that asked: Mobile web", async () => {
		const service = new MobileWebService({ prefs: { get: () => 1 } } as never);
		// The first service of this module is number 1; 99 names none.
		ask("mobileWeb.ask", { service: 1, call: 6, token: 1, op: "prefGet", key: "k" }, 3);
		await vi.waitFor(() => expect(answerTo("mobileWeb.answer")).toBeDefined());
		expect(answerTo("mobileWeb.answer")).toEqual({
			method: "mobileWeb.answer",
			params: { call: 6, ok: true, result: { value: 1 } },
			options: { generation: 3 },
		});
		fake.calls.length = 0;
		ask("mobileWeb.ask", { service: 99, call: 7, token: 2, op: "prefGet", key: "k" }, 8);
		await vi.waitFor(() => expect(answerTo("mobileWeb.answer")).toBeDefined());
		expect(answerTo("mobileWeb.answer")).toMatchObject({
			params: { call: 7, ok: false, message: "cancelled" },
			options: { generation: 8 },
		});
		service.dispose();
	});
});
