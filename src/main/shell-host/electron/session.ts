/**
 * `session` and `protocol`: a partition is a CEF request context in the shell (PROTOCOL.md §6). Main's use of it is
 * small and declarative: a proxy, languages, and custom schemes served by main (`omp-media://`). Permissions,
 * downloads and preload scripts are the shell's: its `preview` module owns the only pages that needed them.
 */

import { EventEmitter } from "node:events";
import { Answered } from "../client";
import type { Host } from "./host";

/** The partition of `session.defaultSession`: the app's own pages. */
export const DEFAULT_PARTITION = "app";

export type ProtocolHandler = (request: Request) => Response | Promise<Response>;

interface SessionCreated {
	spellCheckerLanguages: string[];
	availableSpellCheckerLanguages: string[];
	/** The folder of the partition's HTTP cache; null: it has none on disk (an in-memory partition). */
	cachePath: string | null;
}

export class Protocol {
	readonly #host: Host;
	readonly #partition: string;
	readonly #handlers = new Map<string, ProtocolHandler>();

	constructor(host: Host, partition: string) {
		this.#host = host;
		this.#partition = partition;
	}

	handle(scheme: string, handler: ProtocolHandler): void {
		const name = scheme.toLowerCase();
		if (this.#handlers.has(name)) throw new Error(`The scheme '${name}' has been registered`);
		this.#handlers.set(name, handler);
		this.#host.post("session.op", { partition: this.#partition, op: "handleScheme", args: { scheme: name } });
	}

	unhandle(scheme: string): void {
		const name = scheme.toLowerCase();
		if (!this.#handlers.delete(name)) return;
		this.#host.post("session.op", { partition: this.#partition, op: "unhandleScheme", args: { scheme: name } });
	}

	isProtocolHandled(scheme: string): boolean {
		return this.#handlers.has(scheme.toLowerCase());
	}

	handlerFor(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme.toLowerCase());
	}
}

export class Session extends EventEmitter {
	readonly partition: string;
	readonly protocol: Protocol;
	readonly #host: Host;
	#spellChecker: string[] = [];
	#availableSpellChecker: string[] = [];
	#cachePath: string | null = null;
	readonly ready: Promise<void>;

	constructor(host: Host, partition: string, options: { cache?: boolean } = {}) {
		super();
		this.#host = host;
		this.partition = partition;
		this.protocol = new Protocol(host, partition);
		this.ready = host.client.call<SessionCreated>("session.create", { partition, cache: options.cache ?? true }).then(
			created => {
				this.#spellChecker = created.spellCheckerLanguages;
				this.#availableSpellChecker = created.availableSpellCheckerLanguages;
				this.#cachePath = created.cachePath ?? null;
			},
			(error: unknown) => {
				host.warn(`session.create ${partition}: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
	}

	#op<T = unknown>(op: string, args: unknown = {}): Promise<T> {
		return this.ready.then(() => this.#host.client.call<T>("session.op", { partition: this.partition, op, args }));
	}

	/** The folder of this session's HTTP cache (known once `ready`); null for an in-memory partition. */
	getCachePath(): string | null {
		return this.#cachePath;
	}

	get availableSpellCheckerLanguages(): string[] {
		return [...this.#availableSpellChecker];
	}

	getSpellCheckerLanguages(): string[] {
		return [...this.#spellChecker];
	}

	setSpellCheckerLanguages(languages: string[]): void {
		this.#spellChecker = [...languages];
		void this.#op("setSpellCheckerLanguages", { languages }).catch((error: unknown) =>
			this.#host.warn(`setSpellCheckerLanguages: ${String(error)}`),
		);
	}

	addWordToSpellCheckerDictionary(word: string): boolean {
		void this.#op("addWordToSpellCheckerDictionary", { word }).catch((error: unknown) =>
			this.#host.warn(`addWordToSpellCheckerDictionary: ${String(error)}`),
		);
		return true;
	}

	async resolveProxy(url: string): Promise<string> {
		return (await this.#op<{ result: string }>("resolveProxy", { url })).result;
	}

	async clearCache(): Promise<void> {
		await this.#op("clearCache");
	}
}

/** Serves `protocol.request`: runs the partition's handler for the scheme, answers with the head and streams the body. */
export function serveProtocolRequests(host: Host, sessions: (partition: string) => Session): void {
	const streams = new Map<number, AbortController>();
	let nextStream = 1;
	host.client.on("protocol.cancel", ({ streamId }: { streamId: number }) => streams.get(streamId)?.abort());
	host.client.handle(
		"protocol.request",
		async (
			params: {
				scheme: string;
				partition: string;
				url: string;
				method: string;
				headers: Array<[string, string]>;
				hasBody?: boolean;
			},
			{ bin, signal },
		) => {
			const handler = sessions(params.partition).protocol.handlerFor(params.scheme);
			if (!handler) throw new Error(`No handler for ${params.scheme}`);
			const hasBody = params.hasBody === true && params.method !== "GET" && params.method !== "HEAD";
			const request = new Request(params.url, {
				method: params.method,
				headers: params.headers,
				...(hasBody ? { body: bin ?? new Uint8Array(), duplex: "half" } : {}),
				signal,
			} as RequestInit);
			const response = await handler(request);
			const streamId = nextStream++;
			const controller = new AbortController();
			streams.set(streamId, controller);
			signal.addEventListener("abort", () => controller.abort(), { once: true });
			setImmediate(() => void pump(host, streamId, response, controller, streams));
			return {
				status: response.status,
				statusText: response.statusText,
				headers: [...response.headers.entries()],
				streamId,
			};
		},
	);
}

async function pump(
	host: Host,
	streamId: number,
	response: Response,
	controller: AbortController,
	streams: Map<number, AbortController>,
): Promise<void> {
	try {
		const reader = response.body?.getReader();
		if (reader) {
			controller.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
			for (;;) {
				const { done, value } = await reader.read();
				if (done || controller.signal.aborted) break;
				if (value.byteLength > 0) await host.client.event("protocol.chunk", { streamId }, value);
			}
		}
		if (!controller.signal.aborted) await host.client.event("protocol.end", { streamId });
	} catch (error) {
		await host.client.event("protocol.end", {
			streamId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		streams.delete(streamId);
	}
}

export { Answered };
