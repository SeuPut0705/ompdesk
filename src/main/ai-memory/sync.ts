/**
 * Memory shared between a person's paired computers (C8): the typed client of the core's memory sync
 * (`native/ompdesk/crates/core/src/memsync`), which runs a device's rounds with each host (pages, then session
 * conclusions, each pulled then pushed; every five minutes while a host is connected and whenever its link comes
 * up), keeps the cursors and agreement pairs in `<userData>/ai-memory/sync.json`, answers a device's
 * `host.memory.*` requests from this computer's server, and computes the page hashes older computers compare.
 *
 * What stays here is what the core asks main for (`memsync.ask`, answered with `memsync.answer`):
 * - `request`: one request over a host's link (`RemoteDevices.request`). This is the link seam: the links and their
 *   requests are main's until the remote program (R5-R7) moves them into the core.
 * - `state`: this computer's memory server (null while memory is off), its device id, the hosts connected now and
 *   the clock.
 * - `redact`: texts through `redactDiagnosticsText` (`resources/gui-bridge/redactor.ts`, the one redactor), so a
 *   conclusion is redacted again before it leaves and when it arrives.
 * The core's runtime-log lines (`memsync.log`) go to the sync's `log`.
 */

import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { core } from "../core/process";
import {
	MEMORY_REQUEST_TIMEOUT_MS,
	type MemoryConclusionPullParams,
	type MemoryConclusionPullReply,
	type MemoryConclusionPushParams,
	type MemoryConclusionPushReply,
	type MemoryPullParams,
	type MemoryPullReply,
	type MemoryPushParams,
	type MemoryPushReply,
} from "../remote/app-protocol";
import type { AiMemoryServer, MemoryConclusionCopy } from "./client";

/** A round runs as long as its batches take; `sync()` waits for it. */
const ROUND_WAIT_MS = 2 ** 31 - 1;

/** One page of a conclusion stream. */
export interface ConclusionPage {
	rows: MemoryConclusionCopy[];
	next: number;
	more: boolean;
	/** The database the seqs belong to. */
	store: string;
	/** The stream's highest seq now (0 when empty). */
	last: number;
}

/** The host side: this computer's server (null while memory is off) and this computer's device id. */
export interface MemoryHostDeps {
	server(): AiMemoryServer | null;
	selfId(): string;
}

export interface MemorySyncReport {
	pulled: number;
	pushed: number;
	conflicts: number;
	/** Session conclusions written here (pulled) and written on the host (pushed) this round. */
	conclusions: { pulled: number; pushed: number };
}

export interface MemorySyncDeps extends MemoryHostDeps {
	/** The hosts this computer is connected to now. */
	onlineHosts(): string[];
	/** One request to a host over its link (RemoteDevices.request). */
	request<T>(host: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
	/** `<userData>/ai-memory/sync.json`: cursors and agreement pairs per host. */
	stateFile: string;
	/** A line in the runtime log (source `memory-sync`). */
	log(message: string, details: Record<string, unknown>): void;
	intervalMs?: number;
	/** The clock the identity pass is timed by; tests set it. */
	now?: () => number;
}

type Ask =
	| { call: number; kind: "redact"; texts: string[] }
	| { call: number; kind: "state"; sync: number }
	| { call: number; kind: "request"; sync: number; host: string; method: string; params: unknown; timeoutMs: number };

const syncs = new Map<number, MemorySync>();
let routed = false;

/** The core's asks and log lines reach the sync they name; a redaction is answered here. */
function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("memsync.ask", (data, _bin, generation) => {
		const ask = data as Ask;
		// The core numbers its asks from 1 at every start: only the core that asked may hear the answer.
		const answer = (result: unknown) =>
			void process.call("memsync.answer", { call: ask.call, result }, { generation }).catch(() => undefined);
		if (ask.kind === "redact") answer(ask.texts.map(redactDiagnosticsText));
		else {
			const sync = syncs.get(ask.sync);
			if (sync) void sync.answer(ask).then(answer);
			else answer(ask.kind === "state" ? { server: null } : { error: { code: "internal", message: "no sync" } });
		}
	});
	process.on("memsync.log", data => {
		const { sync, message, details } = data as { sync: number; message: string; details: Record<string, unknown> };
		syncs.get(sync)?.logged(message, details);
	});
}

async function serve<T>(method: string, deps: MemoryHostDeps, peer: string, params: unknown): Promise<T> {
	route();
	const sent = { server: deps.server(), self: deps.selfId(), peer, params };
	return (await core().call<T>(`memsync.${method}`, sent, { timeoutMs: MEMORY_REQUEST_TIMEOUT_MS })).result;
}

/** `host.memory.pull`: this computer's durable pages after `since`, oldest first, none of `peer`'s own copies. */
export function servePull(deps: MemoryHostDeps, peer: string, params: MemoryPullParams): Promise<MemoryPullReply> {
	return serve("servePull", deps, peer, params);
}

/**
 * `host.memory.push`: write each page here unless this computer already holds it, or changed it since the device
 * last saw it (`conflict`, with this computer's version, so the device settles it at once).
 */
export function servePush(deps: MemoryHostDeps, peer: string, params: MemoryPushParams): Promise<MemoryPushReply> {
	return serve("servePush", deps, peer, params);
}

/**
 * `host.memory.conclusions.pull`: this computer's own conclusions after `since.native`, then the ones it holds from
 * other computers after `since.synced`, at most 200 together, none that `peer` captured. Memory off: nothing read.
 */
export function serveConclusionPull(
	deps: MemoryHostDeps,
	peer: string,
	params: MemoryConclusionPullParams,
): Promise<MemoryConclusionPullReply> {
	return serve("serveConclusionPull", deps, peer, params);
}

/**
 * `host.memory.conclusions.push`: write each conclusion here under the computer that captured it, unless this
 * computer holds it already or it is this computer's own coming back (`same`). A group the server refuses or fails on
 * is `failed` for its rows only.
 */
export function serveConclusionPush(
	deps: MemoryHostDeps,
	peer: string,
	params: MemoryConclusionPushParams,
): Promise<MemoryConclusionPushReply> {
	return serve("serveConclusionPush", deps, peer, params);
}

/**
 * A page of a conclusion stream from the cursor `after`, which was read from the database `known`; a cursor of
 * another database, or past the stream's end, reads from 0 (`after: 0`).
 */
export async function readConclusions(
	server: AiMemoryServer,
	source: "native" | "synced",
	after: number,
	known: string | undefined,
	limit: number,
): Promise<{ page: ConclusionPage; after: number }> {
	const params = { server, source, after, ...(known === undefined ? {} : { known }), limit };
	return (await core().call<{ page: ConclusionPage; after: number }>("memsync.readConclusions", params)).result;
}

let nextSync = 0;

/** The device side: syncs with every connected host while memory is on. */
export class MemorySync {
	readonly #deps: MemorySyncDeps;
	readonly #id = ++nextSync;
	#started = false;
	#disposed = false;

	constructor(deps: MemorySyncDeps) {
		this.#deps = deps;
		route();
		syncs.set(this.#id, this);
	}

	#call<T>(method: string, extra: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		const params = {
			sync: this.#id,
			stateFile: this.#deps.stateFile,
			...(this.#deps.intervalMs ? { intervalMs: this.#deps.intervalMs } : {}),
			started: this.#started,
			...extra,
		};
		return core()
			.call<T>(`memsync.${method}`, params, timeoutMs ? { timeoutMs } : {})
			.then(answer => answer.result);
	}

	/** Rounds every few minutes with each connected host, from now on. */
	start(): void {
		if (this.#disposed) return;
		this.#started = true;
		void this.#call("start").catch(() => undefined);
	}

	/** A host's link came up: it may run a newer OMPdesk now, and its pages and conclusions may have changed meanwhile. */
	hostOnline(host: string): void {
		if (this.#disposed) return;
		void this.#call("hostOnline", { host }).catch(() => undefined);
	}

	syncAll(): void {
		if (this.#disposed) return;
		void this.#call("syncAll").catch(() => undefined);
	}

	/** One round with `host`: pages, then conclusions, each pull then push. Null when nothing ran (memory off, an older host). */
	sync(host: string): Promise<MemorySyncReport | null> {
		if (this.#disposed) return Promise.resolve(null);
		return this.#call<MemorySyncReport | null>("sync", { host }, ROUND_WAIT_MS).catch(() => null);
	}

	/** No more rounds start; one running ends as it would. */
	dispose(): void {
		this.#disposed = true;
		void core()
			.call("memsync.dispose", { sync: this.#id })
			.catch(() => undefined);
	}

	/** What the core asks this sync for. */
	async answer(ask: Exclude<Ask, { kind: "redact" }>): Promise<unknown> {
		if (ask.kind === "state") {
			return {
				server: this.#deps.server(),
				self: this.#deps.selfId(),
				hosts: this.#deps.onlineHosts(),
				now: (this.#deps.now ?? Date.now)(),
			};
		}
		try {
			return { result: await this.#deps.request(ask.host, ask.method, ask.params, ask.timeoutMs) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: { code: ipcErrorCode(error) ?? "internal", message } };
		}
	}

	logged(message: string, details: Record<string, unknown>): void {
		this.#deps.log(message, details);
	}
}
