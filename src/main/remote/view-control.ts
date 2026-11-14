import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SessionViewHandle } from "../../shared/session-view";
import {
	parseViewCloseFacts,
	type ViewAuthorization,
	type ViewCloseFacts,
	type ViewRoster,
} from "../agent-control/service";
import type { HostConnection } from "./host-server";

export interface HostedViewControl {
	call(peerId: string, method: string, params: unknown, conn: HostConnection): Promise<unknown>;
	connected?(peerId: string, conn: HostConnection): void;
	disconnected?(peerId: string, conn: HostConnection): void;
}

export interface ViewChannel {
	readonly identity: object;
	request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

export interface ViewTransport {
	peers(): string[];
	channel(peerId: string): ViewChannel | null;
}

const id = z.string().min(1).max(4096);
const Handle = z.object({ viewHost: id, window: id, tabId: id, session: id, incarnation: id }).strict();
const Token = z.string().regex(/^[a-f0-9]{64}$/);
const Close = z.object({ handle: Handle, token: Token }).strict();
const Phase = z.enum(["initial", "final"]);
const Answer = z.object({ handle: Handle, token: Token, nonce: Token, phase: Phase }).strict();

function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function sameHandle(a: SessionViewHandle, b: SessionViewHandle): boolean {
	return (
		a.viewHost === b.viewHost &&
		a.window === b.window &&
		a.tabId === b.tabId &&
		a.session === b.session &&
		a.incarnation === b.incarnation
	);
}
function token(): string {
	return randomBytes(32).toString("hex");
}
function facts(value: unknown): ViewCloseFacts {
	const parsed = parseViewCloseFacts(value);
	Handle.parse(parsed.handle);
	if (parsed.tab.tabId !== parsed.handle.tabId) throw new Error("Invalid view facts");
	return parsed;
}

interface PendingSource {
	peer: string;
	channel: ViewChannel;
	handle: SessionViewHandle;
	authorization: ViewAuthorization;
	reject: (error: unknown) => void;
	state: "initial" | "authorizing" | "authorized" | "validating" | "validated";
	lastNonce: string | null;
	work: Promise<void> | null;
}
interface PendingTarget {
	peer: string;
	conn: HostConnection;
	handle: SessionViewHandle;
	nonce: string;
	state: "initial" | "authorized" | "final" | "confirmed";
	resolve: () => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
}

export class ViewControl implements HostedViewControl {
	readonly #sources = new Map<string, PendingSource>();
	readonly #targets = new Map<string, PendingTarget>();
	readonly #connections = new Map<string, Set<HostConnection>>();
	readonly #live = new Set<HostConnection>();
	readonly #requests = new Map<
		string,
		{
			peer: string;
			conn: HostConnection;
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
			timer: NodeJS.Timeout;
		}
	>();
	constructor(
		readonly deps: {
			deviceId: () => string;
			listLocal: () => ViewCloseFacts[];
			closeLocal: (
				handle: SessionViewHandle,
				authorized: ViewCloseFacts,
				beforeCommit: () => Promise<() => boolean>,
			) => Promise<void>;
			remote: ViewTransport;
			timeoutMs: number;
		},
	) {}

	connected(peer: string, conn: HostConnection): void {
		this.#live.add(conn);
		let connections = this.#connections.get(peer);
		if (!connections) {
			connections = new Set();
			this.#connections.set(peer, connections);
		}
		connections.add(conn);
	}

	connectedOutgoing(conn: HostConnection): void {
		this.#live.add(conn);
	}

	incomingPeers(): string[] {
		return [...this.#connections.keys()];
	}

	incomingChannel(peer: string): ViewChannel | null {
		const conn = [...(this.#connections.get(peer) ?? [])].at(-1);
		if (!conn) return null;
		return {
			identity: conn,
			request: (method, params, timeoutMs) => {
				if (!["views.list", "views.close", "views.authorize"].includes(method))
					return Promise.reject(new Error("Unsupported view method"));
				if (!this.#connections.get(peer)?.has(conn)) return Promise.reject(new Error("View connection closed"));
				const requestId = token();
				const { promise, resolve, reject } = Promise.withResolvers<unknown>();
				const timer = setTimeout(() => {
					this.#requests.delete(requestId);
					reject(new Error("View request timed out"));
				}, timeoutMs);
				this.#requests.set(requestId, { peer, conn, resolve, reject, timer });
				try {
					conn.emit("views.request", { requestId, method, params });
				} catch (error) {
					clearTimeout(timer);
					this.#requests.delete(requestId);
					reject(error);
				}
				return promise;
			},
		};
	}

	#local(): ViewCloseFacts[] {
		return this.deps.listLocal().map(item => {
			const value = facts(item);
			if (value.handle.viewHost !== this.deps.deviceId()) throw new Error("Invalid local view host");
			return value;
		});
	}

	#fresh(handle: SessionViewHandle): ViewCloseFacts {
		const matches = this.#local().filter(item => sameHandle(item.handle, handle));
		const found = matches[0];
		if (matches.length !== 1 || !found?.enabled || handle.viewHost !== this.deps.deviceId())
			throw new Error("View unavailable");
		return found;
	}

	async list(): Promise<ViewRoster> {
		const local = this.#local();
		const remote = await Promise.all(
			this.deps.remote.peers().map(async viewHost => {
				try {
					const channel = this.deps.remote.channel(viewHost);
					if (!channel) throw new Error("View host unavailable");
					const answer = await channel.request("views.list", {}, this.deps.timeoutMs);
					if (!Array.isArray(answer)) throw new Error("Invalid view list");
					const views = answer.map(item => {
						const value = facts(item);
						if (value.handle.viewHost !== viewHost) throw new Error("Invalid view host");
						return value;
					});
					return { views, unavailable: [] };
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return { views: [], unavailable: [{ viewHost, reason }] };
				}
			}),
		);
		return {
			views: local.concat(...remote.map(result => result.views)),
			unavailable: remote.flatMap(result => result.unavailable),
		};
	}

	async close(raw: SessionViewHandle, authorization: ViewAuthorization): Promise<void> {
		if (
			!authorization ||
			typeof authorization.authorize !== "function" ||
			typeof authorization.validate !== "function" ||
			typeof authorization.current !== "function" ||
			typeof authorization.release !== "function"
		) {
			throw new Error("View authorization unavailable");
		}
		let source: PendingSource | undefined;
		let key: string | undefined;
		try {
			const handle = Handle.parse(raw);
			if (handle.viewHost === this.deps.deviceId()) {
				const first = this.#fresh(handle);
				await authorization.authorize(first);
				if (!authorization.current()) throw new Error("View authorization expired");
				const current = this.#fresh(handle);
				if (!equal(first, current)) throw new Error("View changed during authorization");
				let committed = false;
				let guardPassed = false;
				await this.deps.closeLocal(handle, current, async () => {
					if (committed) throw new Error("View authorization already used");
					committed = true;
					await authorization.validate();
					if (!authorization.current()) throw new Error("View authorization expired");
					this.#fresh(handle);
					return () => {
						guardPassed = authorization.current();
						return guardPassed;
					};
				});
				if (!committed || !guardPassed) throw new Error("View close was not confirmed");
				return;
			}
			const channel = this.deps.remote.channel(handle.viewHost);
			if (!channel) throw new Error("View host unavailable");
			key = token();
			const { promise, reject } = Promise.withResolvers<never>();
			source = {
				peer: handle.viewHost,
				channel,
				handle,
				authorization,
				reject,
				state: "initial",
				lastNonce: null,
				work: null,
			};
			this.#sources.set(key, source);
			const result = await Promise.race([
				channel.request("views.close", { handle, token: key }, this.deps.timeoutMs),
				promise,
			]);
			if (result !== "closed" || source.state !== "validated") throw new Error("View close was not confirmed");
		} finally {
			if (key) this.#sources.delete(key);
			if (source?.work) {
				void source.work
					.then(
						() => authorization.release(),
						() => authorization.release(),
					)
					.catch(() => {});
			} else {
				await authorization.release();
			}
		}
	}

	async challenge(peer: string, identity: object, raw: unknown): Promise<void> {
		const parsed = z
			.object({ handle: Handle, token: Token, nonce: Token, phase: Phase, facts: z.unknown() })
			.strict()
			.parse(raw);
		const source = this.#sources.get(parsed.token);
		if (
			!source ||
			source.peer !== peer ||
			source.channel.identity !== identity ||
			!sameHandle(source.handle, parsed.handle) ||
			source.lastNonce === parsed.nonce ||
			(parsed.phase === "initial" ? source.state !== "initial" : source.state !== "authorized")
		)
			throw new Error("Unknown view challenge");
		const fresh = facts(parsed.facts);
		if (!sameHandle(fresh.handle, source.handle)) throw new Error("Invalid challenged view");
		source.lastNonce = parsed.nonce;
		source.state = parsed.phase === "initial" ? "authorizing" : "validating";
		try {
			if (parsed.phase === "initial" && !source.authorization.current())
				throw new Error("View authorization expired");
			const work =
				parsed.phase === "initial" ? source.authorization.authorize(fresh) : source.authorization.validate();
			source.work = work;
			try {
				await work;
			} finally {
				if (source.work === work) source.work = null;
			}
			if (this.#sources.get(parsed.token) !== source || !source.authorization.current()) {
				throw new Error("View challenge expired");
			}
			source.state = parsed.phase === "initial" ? "authorized" : "validated";
			await source.channel.request(
				"views.authorize",
				{ handle: source.handle, token: parsed.token, nonce: parsed.nonce, phase: parsed.phase },
				this.deps.timeoutMs,
			);
		} catch (error) {
			source.reject(error);
			throw error;
		}
	}

	async call(peerId: string, method: string, params: unknown, conn: HostConnection): Promise<unknown> {
		if (method === "views.list") {
			z.object({}).strict().parse(params);
			return this.#local();
		}
		if (method === "views.authorize") {
			const envelope = z
				.discriminatedUnion("kind", [
					z
						.object({
							kind: z.literal("reply"),
							requestId: Token,
							ok: z.boolean(),
							result: z.unknown().optional(),
							error: z.string().optional(),
						})
						.strict(),
					z.object({ kind: z.literal("event"), event: z.literal("views.challenge"), data: z.unknown() }).strict(),
				])
				.safeParse(params);
			if (envelope.success) {
				if (envelope.data.kind === "event") {
					await this.challenge(peerId, conn, envelope.data.data);
				} else {
					const pending = this.#requests.get(envelope.data.requestId);
					if (!pending || pending.peer !== peerId || pending.conn !== conn)
						throw new Error("Unknown view request");
					this.#requests.delete(envelope.data.requestId);
					clearTimeout(pending.timer);
					if (envelope.data.ok) pending.resolve(envelope.data.result);
					else pending.reject(new Error(envelope.data.error ?? "View request failed"));
				}
				return null;
			}
			const answer = Answer.parse(params);
			const target = this.#targets.get(answer.token);
			if (
				!target ||
				target.peer !== peerId ||
				target.conn !== conn ||
				target.nonce !== answer.nonce ||
				!sameHandle(target.handle, answer.handle) ||
				(answer.phase === "initial" ? target.state !== "initial" : target.state !== "final")
			)
				throw new Error("Unknown view authorization");
			target.state = answer.phase === "initial" ? "authorized" : "confirmed";
			target.resolve();
			return null;
		}
		if (method !== "views.close") throw new Error("Unsupported view method");
		const request = Close.parse(params);
		if (request.handle.viewHost !== this.deps.deviceId() || this.#targets.has(request.token))
			throw new Error("Invalid view target");
		const initial = this.#fresh(request.handle);
		const nonce = token();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#targets.delete(request.token);
			target.reject(new Error("View authorization timed out"));
		}, this.deps.timeoutMs);
		const target: PendingTarget = {
			peer: peerId,
			conn,
			handle: request.handle,
			nonce,
			state: "initial",
			resolve,
			reject,
			timer,
		};
		this.#targets.set(request.token, target);
		try {
			try {
				conn.emit("views.challenge", {
					handle: request.handle,
					token: request.token,
					nonce,
					phase: "initial",
					facts: initial,
				});
			} catch (error) {
				reject(error);
			}
			await promise;
			if (!this.#live.has(conn) || this.#targets.get(request.token) !== target)
				throw new Error("View connection closed");
			const current = this.#fresh(request.handle);
			if (!equal(initial, current)) throw new Error("View changed during authorization");
			let guardPassed = false;
			const confirmed = () =>
				this.#live.has(conn) && this.#targets.get(request.token) === target && target.state === "confirmed";
			await this.deps.closeLocal(request.handle, current, async () => {
				if (target.state !== "authorized" || !this.#live.has(conn) || this.#targets.get(request.token) !== target) {
					throw new Error("View authorization expired");
				}
				const finalFacts = this.#fresh(request.handle);
				let finalNonce = token();
				while (finalNonce === target.nonce) finalNonce = token();
				const final = Promise.withResolvers<void>();
				target.nonce = finalNonce;
				target.state = "final";
				target.resolve = final.resolve;
				target.reject = final.reject;
				try {
					conn.emit("views.challenge", {
						handle: request.handle,
						token: request.token,
						nonce: finalNonce,
						phase: "final",
						facts: finalFacts,
					});
				} catch (error) {
					final.reject(error);
				}
				await final.promise;
				if (!confirmed()) {
					throw new Error("View authorization expired");
				}
				return () => {
					guardPassed = confirmed();
					return guardPassed;
				};
			});
			if (!guardPassed || !confirmed()) throw new Error("View close was not confirmed");
			return "closed";
		} finally {
			clearTimeout(timer);
			this.#targets.delete(request.token);
		}
	}

	dropIdentity(peer: string, identity: object): void {
		for (const source of this.#sources.values()) {
			if (source.peer === peer && source.channel.identity === identity)
				source.reject(new Error("View connection closed"));
		}
	}

	disconnected(peer: string, conn: HostConnection): void {
		this.#live.delete(conn);
		const connections = this.#connections.get(peer);
		connections?.delete(conn);
		if (connections?.size === 0) this.#connections.delete(peer);
		for (const [key, pending] of this.#requests) {
			if (pending.peer !== peer || pending.conn !== conn) continue;
			this.#requests.delete(key);
			clearTimeout(pending.timer);
			pending.reject(new Error("View connection closed"));
		}
		for (const [key, target] of this.#targets) {
			if (target.peer !== peer || target.conn !== conn) continue;
			this.#targets.delete(key);
			clearTimeout(target.timer);
			target.reject(new Error("View connection closed"));
		}
		for (const source of this.#sources.values()) {
			if (source.peer === peer && source.channel.identity === conn)
				source.reject(new Error("View connection closed"));
		}
	}
}
