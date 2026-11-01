/**
 * The page's side of `POST /api/session` (src/main/web/server.ts): trade the device cookie, and the device
 * key's signature over a one-time nonce, for the 30-second WebSocket ticket. Two steps when the device has a
 * key (`{}` → `{nonce}`, then `{nonce, sig}` → `{ticket}`), one when it paired without (degraded HTTP mode).
 */
import { loadDeviceKey, signNonce } from "./device-key";

/** The host does not know this browser (never paired, revoked, expired) or refuses its key: pair again. */
export class UnpairedError extends Error {
	constructor(message = "This device is not paired") {
		super(message);
		this.name = "UnpairedError";
	}
}

/** The part of `fetch` the page's HTTP calls use (a test passes a fake). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionDeps {
	fetch: FetchLike;
	/** The page's origin-relative API root; `""` in a browser. */
	base?: string;
	/** This browser's key; null when it has none. */
	loadKey?: () => Promise<{ privateKey: CryptoKey } | null>;
	sign?: (privateKey: CryptoKey, nonce: string) => Promise<string>;
}

interface TicketReply {
	ticket?: unknown;
	nonce?: unknown;
}

async function post(deps: SessionDeps, body: Record<string, string>, signal?: AbortSignal): Promise<TicketReply> {
	const response = await deps.fetch(`${deps.base ?? ""}/api/session`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		credentials: "same-origin",
		cache: "no-store",
		signal,
	});
	if (response.status === 401 || response.status === 403) throw new UnpairedError();
	if (!response.ok) throw new Error(`The computer refused the session (${response.status})`);
	return (await response.json()) as TicketReply;
}

/** `signal` ends a request the network never answers (a phone on a route that no longer exists). */
export async function fetchTicket(deps: SessionDeps, signal?: AbortSignal): Promise<string> {
	const first = await post(deps, {}, signal);
	if (typeof first.ticket === "string") return first.ticket;
	if (typeof first.nonce !== "string") throw new Error("The computer sent no session ticket");
	const key = await (deps.loadKey ?? loadDeviceKey)();
	// The host wants a proof this browser cannot give: its key is gone (site data cleared, ITP).
	if (!key) throw new UnpairedError("This device's key is gone");
	const sig = await (deps.sign ?? signNonce)(key.privateKey, first.nonce);
	const second = await post(deps, { nonce: first.nonce, sig }, signal);
	if (typeof second.ticket !== "string") throw new Error("The computer sent no session ticket");
	return second.ticket;
}
