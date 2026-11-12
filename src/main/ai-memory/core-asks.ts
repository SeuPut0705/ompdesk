/**
 * What the core's memory upkeep and care ask of main (`native/ompdesk/crates/core/src/upkeep/asks.rs`): the event
 * `upkeep.ask` `{service, ask, kind, params}` is answered with the request `upkeep.answer`, and the event `upkeep.log`
 * `{service, message, details}` is one runtime-log line. A client names its service (`serviceName()`) in every request
 * and lists, in the request's `asks`, the kinds it answers; production answers none but, when omp is asked for, `omp`.
 */
import { journalFacts, promptFacts } from "../../../resources/gui-bridge/stock-helper/memory";
import { core } from "../core/process";
import { ompRunEnv, systemOmp } from "../omp-runtime";
import { spawnPath } from "../shell-env";
import { stockHelperHost } from "../stock-helper";
import { AiMemoryClient } from "./client";
import type { DistillMessage, ModelResult, OmpLaunch } from "./distill-model";
import type { PairJudge } from "./memory-judge";

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
	const omp = await systemOmp();
	if (!omp.ok) throw new Error(omp.error);
	return ompLaunchOf(omp.runtime.bin);
}

/** How the omp at `bin` starts: its binary and the environment it runs with (omp's own folders on `PATH`, telemetry off). */
export async function ompLaunchOf(bin: string): Promise<OmpLaunch> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(ompRunEnv(bin, await spawnPath()))) {
		if (value !== undefined) env[name] = value;
	}
	return { bin, env };
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

/**
 * The `journal` ask: what a stored conversation's journal says (`stock-helper/memory.ts journalFacts` of the messages
 * `readMessages` reads along the journal's persisted leaf).
 */
export function journalAsk(readMessages: (path: string) => Promise<readonly unknown[]>): AskHandler {
	return async params => {
		const path = field(params, "path");
		if (typeof path !== "string") throw new Error("A journal ask needs a path");
		return journalFacts(await readMessages(path));
	};
}

/** The `model` ask: the one model call a test's `model` stands in for (`message` is what the core would run). */
export function modelAsk(model: (message: DistillMessage) => Promise<ModelResult>): AskHandler {
	return params => {
		const message = field(params, "message");
		if (message === null || typeof message !== "object") throw new Error("A model ask needs a message");
		const system = field(message, "system");
		const user = field(message, "user");
		return model({ system: String(system ?? ""), user: String(user ?? "") });
	};
}

/** The `judge` ask: a test's pair judge (`care/judge.rs Judge::Main`), given the pairs and the rules-file outline. */
export function judgeAsk(judge: PairJudge): AskHandler {
	return async params => {
		const pairs = field(params, "pairs");
		return await judge(Array.isArray(pairs) ? pairs : [], String(field(params, "rules") ?? ""));
	};
}

/** The `rules` ask: the text of the rules files of the repository `cwd` is in (a test's reader). */
export function rulesAsk(rules: (cwd: string) => Promise<string>): AskHandler {
	return params => rules(String(field(params, "cwd") ?? ""));
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

/** The side of a request that works for no memory client (a judge): it answers `handlers` and nothing else. */
export function askOnly(handlers: Readonly<Record<string, AskHandler>>): CoreSide {
	return { handlers: { ...handlers }, wire: () => ({ asks: Object.keys(handlers) }) };
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

/**
 * One request of a stateless core method (`care.backfill`, `care.curate`, `care.freshness`, `care.judgeSmol`,
 * `care.judgeJev`): `side` answers its asks and `log` hears its runtime-log lines until it answers. `params` are the
 * members the method needs beside the ones every request carries (the service, the asks, the server, the locale).
 */
export async function oneShot<T>(
	method: string,
	side: CoreSide,
	params: Record<string, unknown>,
	options: { timeoutMs: number; log?: (message: string, details: RuntimeLogDetails) => void },
): Promise<T> {
	const service = serviceName();
	const stopAsks = answerAsks(service, side.handlers);
	const stopLog = options.log ? onLog(service, options.log) : () => {};
	try {
		const answer = await core().call<T>(
			method,
			{ service, ...side.wire(), locale: collatorLocale(), ...params },
			{ timeoutMs: options.timeoutMs },
		);
		return answer.result;
	} finally {
		stopAsks();
		stopLog();
	}
}
