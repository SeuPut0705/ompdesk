/**
 * The core's remote bytes (`remotebytes.*`, native/ompdesk/crates/core/src/remotebytes) ask main for what only it
 * reaches: the host, over the link main speaks. Each caller registers what answers its asks under a number the core
 * echoes back (`asker`); main answers with `remotebytes.answer`, or says the caller failed, and the core's call then
 * fails with `ask_failed`, for which `askingCall` rethrows the caller's own error.
 */
import { CoreError, core } from "../core/process";

/** One question of the core: `kind` and what it names (`fromByte`, `ref`, `path`…). */
export type BytesAsk = { kind: string } & Record<string, unknown>;
type Answerer = (ask: BytesAsk) => Promise<unknown>;

/** A core call that waits on one host request, which has its own timeout. */
const ASKING_CALL_MS = 120_000;

const answerers = new Map<number, Answerer>();
let nextAsker = 0;
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("remotebytes.ask", data => {
		const { call, asker, ...ask } = data as { call: number; asker: number } & BytesAsk;
		const reply = (answer: object) =>
			void process.call("remotebytes.answer", { call, ...answer }).catch(() => undefined);
		const answerer = answerers.get(asker);
		if (!answerer) reply({ failed: true });
		else
			answerer(ask).then(
				result => reply({ result }),
				() => reply({ failed: true }),
			);
	});
}

/** Registers a caller whose asks outlive one call (a sign-in's listener); `release` when the core says it ended. */
export function registerAsker(answer: Answerer): { id: number; release: () => void } {
	route();
	const id = ++nextAsker;
	answerers.set(id, answer);
	return { id, release: () => answerers.delete(id) };
}

/** Calls `method` with `asker` set; the core's asks on the way are `answer`'s, and a failed one fails the call with its error. */
export async function askingCall<T>(method: string, params: object, answer: Answerer): Promise<T> {
	let failure: { error: unknown } | null = null;
	const asker = registerAsker(ask =>
		answer(ask).catch((error: unknown) => {
			failure = { error };
			throw error;
		}),
	);
	try {
		return (await core().call<T>(method, { ...params, asker: asker.id }, { timeoutMs: ASKING_CALL_MS })).result;
	} catch (error) {
		if (failure && error instanceof CoreError && error.code === "ask_failed")
			throw (failure as { error: unknown }).error;
		throw error;
	} finally {
		asker.release();
	}
}
