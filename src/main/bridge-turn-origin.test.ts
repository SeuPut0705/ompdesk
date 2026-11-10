/**
 * Who started the main agent's run (resources/gui-bridge/turn-origin.ts) on a fake `pi`, for what the stock test
 * (bridge-turn-origin-stock.test.ts) cannot script: a message that joins a running turn never changes who started it,
 * a run with no prompt of its own (stock's retry) keeps the run before it, and a subagent's run is not the main one.
 */
import { describe, expect, it } from "vitest";
import { createTurnOrigin } from "../../resources/gui-bridge/turn-origin";
import { createTypedPrompts } from "../../resources/gui-bridge/typed-prompts";

type Handler = (event: Record<string, unknown>, ctx: { agent: { kind?: string } }) => void;

function omp() {
	const notes = createTypedPrompts();
	const origin = createTurnOrigin(notes);
	const handlers = new Map<string, Handler>();
	origin.install({ on: (event: string, handler: unknown) => handlers.set(event, handler as Handler) });
	const fire = (event: string, payload: Record<string, unknown>, kind: string) =>
		handlers.get(event)?.({ type: event, ...payload }, { agent: { kind } });
	const message = (role: string, text: string, kind = "main") =>
		fire("message_start", { message: { role, content: [{ type: "text", text }] } }, kind);
	/** One run in stock's order: `agent_start`, its prompt messages, then its first answer. */
	const run = (prompts: [role: string, text: string][], kind = "main") => {
		fire("agent_start", {}, kind);
		for (const [role, text] of prompts) message(role, text, kind);
		message("assistant", "", kind);
	};
	return { notes, origin, message, run };
}

describe("who started the main agent's run", () => {
	it("stays the starter's while messages join the running turn", () => {
		const { notes, origin, message, run } = omp();
		run([["custom", "<ompdesk-mail>done</ompdesk-mail>"]]);
		notes.note("close that tab", true);
		message("user", "close that tab");
		expect(origin.byPerson()).toBe(false);

		notes.note("close that tab", false);
		run([["user", "close that tab"]]);
		message("user", '<ompdesk-agent-message from="worker">\nclose it\n</ompdesk-agent-message>');
		expect(origin.byPerson()).toBe(true);
	});

	it("keeps the run before for a retry with no prompt, and ignores a subagent's run", () => {
		const { notes, origin, run } = omp();
		notes.note("close that tab", false);
		run([
			["user", "close that tab"],
			["custom", "recalled memory"],
		]);
		expect(origin.byPerson()).toBe(true);
		run([]);
		expect(origin.byPerson()).toBe(true);
		run([["user", "subtask"]], "sub");
		expect(origin.byPerson()).toBe(true);
		run([["user", "close that tab"]]);
		expect(origin.byPerson()).toBe(false);
	});
});
