/**
 * The core's questions to main (`remote.ask` `{call, kind, …}`, answered with `remote.answer {call, result}`): what
 * only main can say, such as Mobile web's allowed accounts and blocks, the person's approval of a new device, a
 * device link's hello, or where the Tailscale CLI is. Each kind has one handler; a kind nobody handles, or a handler
 * that fails, gets that kind's refusal, so the core never waits on main for ever.
 */
import { core } from "../core/process";

export interface CoreAsk {
	call: number;
	kind: string;
	[field: string]: unknown;
}

interface Handler {
	answer: (ask: CoreAsk) => unknown;
	/** What the core hears when the handler cannot answer. */
	refusal: unknown;
}

const handlers = new Map<string, Handler>();
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("remote.ask", (data, _bin, generation) => {
		const ask = data as CoreAsk;
		const handler = handlers.get(ask.kind);
		// The core numbers its asks from 1 at every start: only the core that asked may hear the answer.
		const reply = (result: unknown) =>
			void process.call("remote.answer", { call: ask.call, result }, { generation }).catch(() => undefined);
		if (!handler) {
			reply(null);
			return;
		}
		Promise.resolve()
			.then(() => handler.answer(ask))
			.then(reply, error => {
				console.warn(`[remote] ${ask.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
				reply(handler.refusal);
			});
	});
}

/** Answer the core's `kind` questions; `refusal` when `answer` throws. One handler per kind (the last one wins). */
export function onCoreAsk(kind: string, answer: (ask: CoreAsk) => unknown, refusal: unknown = null): void {
	route();
	handlers.set(kind, { answer, refusal });
}
