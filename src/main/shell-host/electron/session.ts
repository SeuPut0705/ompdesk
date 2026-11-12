/**
 * `session` and `protocol`: a partition is a CEF request context in the shell (PROTOCOL.md §6). Main's use of it is
 * small and all declarative: a proxy, languages, "deny every permission", "cancel every download", a preload script
 * for the Preview's dialogs, and custom schemes served by main (`omp-media://`, `omp-visual://`). The permission
 * handlers Electron takes as functions are probed once (main's are `callback(false)`), because a function cannot
 * cross the socket; a handler that would grant something is refused loudly.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Answered } from "../client";
import { type Host, makeEvent } from "./host";

/** The partition of `session.defaultSession`: the app's own pages. */
export const DEFAULT_PARTITION = "app";

const PROBED_PERMISSIONS = [
	"media",
	"geolocation",
	"notifications",
	"clipboard-read",
	"clipboard-sanitized-write",
	"midi",
	"fullscreen",
	"pointerLock",
	"openExternal",
	"display-capture",
] as const;

export type ProtocolHandler = (request: Request) => Response | Promise<Response>;

interface SessionCreated {
	userAgent: string;
	acceptLanguages: string;
	spellCheckerLanguages: string[];
	availableSpellCheckerLanguages: string[];
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

export interface DownloadItem {
	getURL(): string;
	getFilename(): string;
	getMimeType(): string;
	getTotalBytes(): number;
	cancel(): void;
}

export class Session extends EventEmitter {
	readonly partition: string;
	readonly protocol: Protocol;
	readonly #host: Host;
	#userAgent = "";
	#acceptLanguages = "";
	#spellChecker: string[] = [];
	#availableSpellChecker: string[] = [];
	readonly ready: Promise<void>;

	constructor(host: Host, partition: string, options: { cache?: boolean } = {}) {
		super();
		this.#host = host;
		this.partition = partition;
		this.protocol = new Protocol(host, partition);
		this.ready = host.client.call<SessionCreated>("session.create", { partition, cache: options.cache ?? true }).then(
			created => {
				this.#userAgent = created.userAgent;
				this.#acceptLanguages = created.acceptLanguages;
				this.#spellChecker = created.spellCheckerLanguages;
				this.#availableSpellChecker = created.availableSpellCheckerLanguages;
			},
			(error: unknown) => {
				host.warn(`session.create ${partition}: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
		this.on("newListener", name => {
			if (name === "will-download") this.#op("setDownloads", { mode: "deny" });
		});
	}

	#op<T = unknown>(op: string, args: unknown = {}): Promise<T> {
		return this.ready.then(() => this.#host.client.call<T>("session.op", { partition: this.partition, op, args }));
	}

	getUserAgent(): string {
		return this.#userAgent;
	}

	/** Sets the user agent, and the Accept-Language list when given (what a Preview page announces). */
	setUserAgent(userAgent: string, acceptLanguages?: string): void {
		this.#userAgent = userAgent;
		if (acceptLanguages !== undefined) this.#acceptLanguages = acceptLanguages;
		void this.#op("setUserAgent", { userAgent, ...(acceptLanguages === undefined ? {} : { acceptLanguages }) }).catch(
			(error: unknown) => this.#host.warn(`setUserAgent: ${String(error)}`),
		);
	}

	getAcceptLanguages(): string {
		return this.#acceptLanguages;
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

	async setProxy(config: {
		mode?: string;
		proxyRules?: string;
		pacScript?: string;
		proxyBypassRules?: string;
	}): Promise<void> {
		await this.#op("setProxy", config);
	}

	async resolveProxy(url: string): Promise<string> {
		return (await this.#op<{ result: string }>("resolveProxy", { url })).result;
	}

	async clearCache(): Promise<void> {
		await this.#op("clearCache");
	}

	async clearStorageData(): Promise<void> {
		await this.#op("clearStorageData");
	}

	/** Denies every permission request: the handler is probed, since a function cannot cross the socket. */
	setPermissionRequestHandler(handler: ((...args: never[]) => void) | null): void {
		if (handler === null) {
			void this.#op("setPermissions", { mode: "default" });
			return;
		}
		let granted = false;
		let answered = 0;
		for (const permission of PROBED_PERMISSIONS) {
			(handler as (...args: unknown[]) => void)(
				null,
				permission,
				(allow: boolean) => {
					answered += 1;
					if (allow) granted = true;
				},
				{ requestingUrl: "about:blank", isMainFrame: true },
			);
		}
		if (granted || answered !== PROBED_PERMISSIONS.length)
			throw new Error("Only a permission handler that denies everything is supported under the shell");
		void this.#op("setPermissions", { mode: "deny-all" });
	}

	setPermissionCheckHandler(handler: ((...args: never[]) => boolean) | null): void {
		if (handler === null) return;
		for (const permission of PROBED_PERMISSIONS) {
			if ((handler as (...args: unknown[]) => boolean)(null, permission, "about:blank", {}))
				throw new Error("Only a permission check that denies everything is supported under the shell");
		}
		void this.#op("setPermissions", { mode: "deny-all" });
	}

	/** Runs a script file in every frame of this partition before page scripts (`__ompdeskSendSync` in scope). */
	registerPreloadScript(script: { type: "frame"; filePath: string; id?: string }): string {
		const id = script.id ?? randomUUID();
		void this.#op("registerPreload", { id, source: readFileSync(script.filePath, "utf8") }).catch((error: unknown) =>
			this.#host.warn(`registerPreloadScript: ${String(error)}`),
		);
		return id;
	}

	/** Dispatches the shell's `session.download` (a download it cancelled). */
	emitDownload(item: DownloadItem, contents: unknown): void {
		this.emit("will-download", makeEvent(), item, contents);
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
