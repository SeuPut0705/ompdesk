import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent, type Omp, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Stock's stop-time todo reminder ("You stopped with N incomplete todo item(s) … (Reminder 1/3)") woke a session that
 * ended its turn only because its open items wait on another session; it wrote a second "still waiting" answer and the
 * person read the same thing twice. The bridge (todo-wait.ts) keeps the reminder from waking such a session, and
 * leaves it for one that has something to continue.
 *
 * The provider scripts the same turns every time: a todo list, one more step or none, then a plain answer. The
 * reminder is read where the model reads it: in the request that follows the answer.
 */

const OPEN = "ompdesk_session_open";

interface Script {
	items: string[];
	/** Call the host tool `ompdesk_session_open` after the list; the host answers that a child works. */
	open?: boolean;
}

/** The main agent's requests in order: the list, the open (when asked), a plain answer, then plain answers. */
async function start(script: Script): Promise<{ bodies: string[]; session: Omp }> {
	const provider = await startProvider(step => {
		if (step === 1)
			return sse(toolCall("todo", { op: "init", list: [{ phase: "Work", items: script.items }] }), "tool_calls");
		if (step === 2 && script.open) return sse(toolCall(OPEN, { message: "Look into the build" }), "tool_calls");
		return sse([{ content: "Nothing more to do for now." }], "stop");
	});
	const session = await startOmp({
		...fakeAgent(provider.url),
		model: "fake/m1",
		bridge: resolve("resources/gui-bridge/index.ts"),
		hostTools: script.open
			? {
					[OPEN]: {
						description: "Open a session",
						parameters: { type: "object", properties: { message: { type: "string" } } },
						answer: "Opened session 15c8906674c31761 in /w. It is working on your message.",
					},
				}
			: undefined,
	});
	return { bodies: provider.bodies, session };
}

/** The main agent's requests that carried stock's reminder. */
function reminded(bodies: readonly string[]): number {
	return bodies.filter(body => body.includes("You stopped with")).length;
}

describe.skipIf(!existsSync(omp))("stock's todo reminder on a session that waits, on stock omp", () => {
	it("still reminds a session that stopped with an item it can act on", async () => {
		const { bodies, session } = await start({ items: ["Integrate the result", "Write the report"] });
		await session.turn("Work through the list");
		expect(reminded(bodies)).toBe(1);
		expect(bodies.at(-1)).toContain("You stopped with 2 incomplete todo item(s)");
	}, 180_000);

	it("does not wake a session whose open items are all written as waiting", async () => {
		const { bodies, session } = await start({ items: ["Wait for the inquiry tab's reply", "대기: CI 결과"] });
		await session.turn("Work through the list");
		expect(bodies).toHaveLength(2);
		expect(reminded(bodies)).toBe(0);
	}, 180_000);

	it("does not wake a session that opened a child and waits for its report, though an item is actionable", async () => {
		const { bodies, session } = await start({ items: ["Integrate the child's result"], open: true });
		await session.turn("Ask a session to look into the build");
		expect(bodies).toHaveLength(3);
		expect(reminded(bodies)).toBe(0);
	}, 180_000);
});
