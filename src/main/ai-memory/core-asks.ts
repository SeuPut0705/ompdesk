/**
 * What the core's memory upkeep and care ask of main (`native/ompdesk/crates/core/src/upkeep/asks.rs`): the event
 * `upkeep.ask` `{service, ask, kind, params}` is answered with the request `upkeep.answer`, and the event `upkeep.log`
 * `{service, message, details}` is one runtime-log line. A client names its service (`serviceName()`) in every request
 * and lists, in the request's `asks`, the kinds it answers; production answers none but, when omp is asked for, `omp`.
 */
import { promptFacts } from "../../../resources/gui-bridge/stock-helper/memory";
import { core } from "../core/process";
import { ompRunEnv, systemOmp } from "../omp-runtime";
import { spawnPath } from "../shell-env";
import { stockHelperHost } from "../stock-helper";
import { AiMemoryClient } from "./client";
import type { OmpLaunch } from "./distill-model";

/** Answers one ask: its value, or a throw whose message is the refusal the core hands its caller. */
export type AskHandler = (params: unknown) => unknown | Promise<unknown>;

export type RuntimeLogDetails = Record<string, string | number | boolean | null>;

let services = 0;

/** A name for one client's service in the core, apart from every other this process makes. */
export function serviceName(): string {
	return `${process.pid}-${++services}`;
}

/** `value[key]` when `value` is an object holding it. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

/**
 * Answers the asks of `service` with `handlers` (by kind) until the returned function is called. An ask with no
 * handler is refused, so the core's request fails with a message instead of waiting.
 */
export function answerAsks(service: string, handlers: Readonly<Record<string, AskHandler>>): () => void {
	return core().on("upkeep.ask", data => {
		const ask = field(data, "ask");
		const kind = field(data, "kind");
		if (field(data, "service") !== service || typeof ask !== "number" || typeof kind !== "string") return;
		const handler = Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
		void (async () => {
			try {
				if (!handler) throw new Error(`Nothing answers the ask "${kind}"`);
				return { ask, ok: true, value: await handler(field(data, "params")) };
			} catch (error) {
				return { ask, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		})()
			.then(answer => core().call("upkeep.answer", answer))
			// A core that ended meanwhile has nothing left that waits for it.
			.catch(() => {});
	});
}

/** Writes each runtime-log line of `service` with `log` until the returned function is called. */
export function onLog(service: string, log: (message: string, details: RuntimeLogDetails) => void): () => void {
	return core().on("upkeep.log", data => {
		const message = field(data, "message");
		const details = field(data, "details");
		if (field(data, "service") !== service || typeof message !== "string") return;
		log(message, details !== null && typeof details === "object" ? (details as RuntimeLogDetails) : {});
	});
}

/** How omp starts for the core's model calls: the user's omp and the environment it runs with. Throws omp's own
 * words when none can run. */
export async function ompLaunch(): Promise<OmpLaunch> {
	const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
	if (!omp.ok) throw new Error(omp.error);
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(ompRunEnv(omp.runtime.bin, basePath))) {
		if (value !== undefined) env[name] = value;
	}
	return { bin: omp.runtime.bin, env };
}

/**
 * The `client` ask: calls the method `op` of a test's fake client with `args`, as the core's `Store::Main` sends them
 * (`retirePage`'s `at` comes as the ISO string `Date.toISOString` wrote and goes back to a `Date`).
 */
export function clientAsk(client: object): AskHandler {
	return params => {
		const op = field(params, "op");
		const args = field(params, "args");
		const method = typeof op === "string" && Object.hasOwn(client, op) ? Reflect.get(client, op) : undefined;
		if (typeof method !== "function") throw new Error(`The client has no ${String(op)}`);
		const given = Array.isArray(args) ? [...args] : [];
		if (op === "retirePage") {
			const input = given[0];
			if (input !== null && typeof input === "object" && typeof field(input, "at") === "string") {
				given[0] = { ...input, at: new Date(field(input, "at") as string) };
			}
		}
		return Reflect.apply(method, client, given);
	};
}

/** The `facts` ask: the memory-prompt facts of each item (`resources/gui-bridge/stock-helper/memory.ts promptFacts`). */
export function factsAsk(): AskHandler {
	return params => {
		const items = field(params, "items");
		return promptFacts(Array.isArray(items) ? items : []);
	};
}

/** The locale main's `localeCompare` resolves: the core orders text with it, as main's `Intl.Collator` did. */
export function collatorLocale(): string {
	return new Intl.Collator().resolvedOptions().locale;
}

/** What a request to the core says of the client it works for: who answers its asks, and what it carries. */
export interface CoreSide {
	handlers: Record<string, AskHandler>;
	/** The members every request of this client carries: the kinds main answers, and for the real client the server
	 * and the stock helper the core reads memory through itself. */
	wire(): { asks: string[]; server?: { url: string | null; dataDir: string | null }; stockHost?: string };
}

/**
 * The real `AiMemoryClient` is not asked at all (the core reads the server itself, from `server()`, and the prompt facts
 * from the stock helper); an object standing in for it (a test's fake) is asked for every call (`client`) and its
 * prompt facts (`facts`). `more` are the asks the caller answers besides.
 */
export function coreSide(client: object, more: Readonly<Record<string, AskHandler>> = {}): CoreSide {
	if (client instanceof AiMemoryClient) {
		return {
			handlers: { ...more },
			wire: () => ({ asks: Object.keys(more), server: client.server(), stockHost: stockHelperHost() }),
		};
	}
	const handlers = { client: clientAsk(client), facts: factsAsk(), ...more };
	return { handlers, wire: () => ({ asks: Object.keys(handlers) }) };
}
