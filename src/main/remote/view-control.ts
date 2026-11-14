import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SessionViewHandle } from "../../shared/session-view";
import { parseViewCloseFacts, type ViewCloseFacts } from "../agent-control/service";
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
const Answer = z.object({ handle: Handle, token: Token, nonce: Token }).strict();

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
	authorize: (facts: ViewCloseFacts) => Promise<void>;
	reject: (error: unknown) => void;
	approved: boolean;
	challenged: boolean;
}
interface PendingTarget {
	peer: string;
	conn: HostConnection;
	handle: SessionViewHandle;
	nonce: string;
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
			closeLocal: (handle: SessionViewHandle, authorized: ViewCloseFacts) => Promise<void>;
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

	async list(): Promise<ViewCloseFacts[]> {
		const local = this.#local();
		const remote = await Promise.all(
			this.deps.remote.peers().map(async peer => {
				const channel = this.deps.remote.channel(peer);
				if (!channel) throw new Error("View host unavailable");
				const answer = await channel.request("views.list", {}, this.deps.timeoutMs);
				if (!Array.isArray(answer)) throw new Error("Invalid view list");
				return answer.map(item => {
					const value = facts(item);
					if (value.handle.viewHost !== peer) throw new Error("Invalid view host");
					return value;
				});
			}),
		);
		return local.concat(...remote);
	}

	async close(raw: SessionViewHandle, authorize: (fresh: ViewCloseFacts) => Promise<void>): Promise<void> {
		const handle = Handle.parse(raw);
		if (typeof authorize !== "function") throw new Error("View authorization unavailable");
		if (handle.viewHost === this.deps.deviceId()) {
			const first = this.#fresh(handle);
			await authorize(first);
			const current = this.#fresh(handle);
			if (!equal(first, current)) throw new Error("View changed during authorization");
			await this.deps.closeLocal(handle, current);
			return;
		}
		const channel = this.deps.remote.channel(handle.viewHost);
		if (!channel) throw new Error("View host unavailable");
		const key = token();
		const { promise, reject } = Promise.withResolvers<never>();
		this.#sources.set(key, {
			peer: handle.viewHost,
			channel,
			handle,
			authorize,
			reject,
			challenged: false,
			approved: false,
		});
		try {
			const result = await Promise.race([
				channel.request("views.close", { handle, token: key }, this.deps.timeoutMs),
				promise,
			]);
			if (result !== "closed" || !this.#sources.get(key)?.approved) throw new Error("View close was not confirmed");
		} finally {
			this.#sources.delete(key);
		}
	}

	async challenge(peer: string, identity: object, raw: unknown): Promise<void> {
		const parsed = z.object({ handle: Handle, token: Token, nonce: Token, facts: z.unknown() }).strict().parse(raw);
		const source = this.#sources.get(parsed.token);
		if (
			!source ||
			source.peer !== peer ||
			source.channel.identity !== identity ||
			source.challenged ||
			!sameHandle(source.handle, parsed.handle)
		)
			throw new Error("Unknown view challenge");
		const fresh = facts(parsed.facts);
		if (!sameHandle(fresh.handle, source.handle)) throw new Error("Invalid challenged view");
		source.challenged = true;
		try {
			await source.authorize(fresh);
			if (this.#sources.get(parsed.token) !== source) throw new Error("View challenge expired");
			source.approved = true;
			await source.channel.request(
				"views.authorize",
				{ handle: source.handle, token: parsed.token, nonce: parsed.nonce },
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
				!sameHandle(target.handle, answer.handle)
			)
				throw new Error("Unknown view authorization");
			this.#targets.delete(answer.token);
			clearTimeout(target.timer);
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
			reject(new Error("View authorization timed out"));
		}, this.deps.timeoutMs);
		this.#targets.set(request.token, { peer: peerId, conn, handle: request.handle, nonce, resolve, reject, timer });
		try {
			try {
				conn.emit("views.challenge", { handle: request.handle, token: request.token, nonce, facts: initial });
			} catch (error) {
				reject(error);
			}
			await promise;
			if (!this.#live.has(conn)) throw new Error("View connection closed");
			const current = this.#fresh(request.handle);
			if (!equal(initial, current)) throw new Error("View changed during authorization");
			await this.deps.closeLocal(request.handle, current);
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
