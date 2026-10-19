/**
 * gui-bridge agent-control.ts worker contract: a session another agent opened journals `ompdesk.worker`
 * (`agent_control.worker`, once), and from then on its main agent's prompt carries the contract; a session without
 * the entry (the parent, anything the user opened) and a worker's own subagents never do.
 */
import { describe, expect, it } from "vitest";
import { install, methods, WORKER_CONTRACT, WORKER_ENTRY } from "../../resources/gui-bridge/agent-control";
import type { JournalEntry, PromptSectionContext, PromptSectionHost } from "../../resources/gui-bridge/prompt-sections";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];
type Handler = Parameters<PromptSectionHost["on"]>[1];

function hook(): Handler {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return handlers[0] as Handler;
}

function session(entries: JournalEntry[], kind = "main"): PromptSectionContext {
	return { sessionManager: { getBranch: () => entries }, agent: { kind } };
}

const BASE = ["You are omp."];

describe("worker contract", () => {
	it("is in the child's prompt and not in the parent's", () => {
		const on = hook();
		const child = on({ systemPrompt: BASE }, session([{ type: "custom", customType: WORKER_ENTRY, data: {} }]));
		expect(child?.systemPrompt).toEqual([...BASE, WORKER_CONTRACT]);
		expect(
			on({ systemPrompt: BASE }, session([{ type: "custom", customType: "ompdesk.agent-answer" }])),
		).toBeUndefined();
	});

	it("asks the worker to end its answer with a Result line the app reads", () => {
		expect(WORKER_CONTRACT).toContain("Result: ok");
		expect(WORKER_CONTRACT).toContain("Result: problem — <reason>");
	});

	it("leaves a worker's own subagents to its brief", () => {
		const entries = [{ type: "custom", customType: WORKER_ENTRY }];
		expect(hook()({ systemPrompt: BASE }, session(entries, "subagent"))).toBeUndefined();
	});

	it("is journaled once by agent_control.worker", async () => {
		const journal: JournalEntry[] = [];
		const env = {
			session: () => ({
				sessionManager: {
					getBranch: () => journal,
					appendCustomEntry: (customType: string, data: unknown) =>
						journal.push({ type: "custom", customType, data }),
				},
			}),
		} as unknown as BridgeEnv;
		await methods["agent_control.worker"]?.({ from: "Boss" }, env);
		await methods["agent_control.worker"]?.({ from: "Boss" }, env);
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({ customType: WORKER_ENTRY, data: { from: "Boss" } });
		await expect(methods["agent_control.worker"]?.({}, env)).rejects.toThrow("from");
	});
});
