/**
 * The page-made push channels (ipc-policy `mode: "client"`): a web page has no OS to hand it an `omp://` link
 * or a notification click, so it reads them from its own URL. `#/open?tab=<id>` is where a notification click
 * lands (the service worker opens the page there), `#/open?session=<id>` and `#/open?new=1` are links, and an
 * `omp://` URL inside content routes the same way.
 */
import type { DeepLinkPayload, NotificationClickPayload } from "../../shared/ipc-types";

export type OpenTarget =
	| { kind: "deep-link"; link: DeepLinkPayload }
	| { kind: "notification-click"; payload: NotificationClickPayload }
	/** A session file to switch to before the first hydration (the "open in new window" handoff). */
	| { kind: "session-path"; sessionPath: string };

/** What `#/open?…` asks for, or null for any other hash. */
export function parseOpenHash(hash: string): OpenTarget | null {
	const match = /^#\/open\?(.*)$/.exec(hash);
	if (!match) return null;
	const params = new URLSearchParams(match[1]);
	const tab = params.get("tab");
	if (tab) return { kind: "notification-click", payload: { tabId: tab } };
	const session = params.get("session");
	if (session) return { kind: "deep-link", link: { action: "switch-session", sessionId: session } };
	const sessionPath = params.get("sessionPath");
	if (sessionPath) return { kind: "session-path", sessionPath };
	if (params.get("new") === "1") return { kind: "deep-link", link: { action: "new-session" } };
	return null;
}

/** `omp://new` and `omp://session/<id>`, as main's deep-link.ts reads them; null for anything else. */
export function parseOmpUrl(url: string): DeepLinkPayload | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "omp:") return null;
	const host = parsed.hostname.toLowerCase();
	if (host === "new") return { action: "new-session" };
	if (host === "session") {
		const sessionId = parsed.pathname.replace(/^\/+|\/+$/g, "");
		if (sessionId) return { action: "switch-session", sessionId };
	}
	return null;
}

/** A tiny typed-by-channel emitter for the channels the page makes itself. */
export class LocalChannels {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	readonly #queued = new Map<string, unknown[]>();

	on(channel: string, listener: (data: unknown) => void): () => void {
		let set = this.#listeners.get(channel);
		if (!set) {
			set = new Set();
			this.#listeners.set(channel, set);
		}
		set.add(listener);
		const queued = this.#queued.get(channel);
		if (queued) {
			this.#queued.delete(channel);
			for (const data of queued) listener(data);
		}
		return () => {
			set.delete(listener);
		};
	}

	/** Deliver `data` now, or to the first listener that subscribes (a link read at boot arrives before the app listens). */
	emit(channel: string, data: unknown): void {
		const listeners = this.#listeners.get(channel);
		if (!listeners || listeners.size === 0) {
			const queued = this.#queued.get(channel) ?? [];
			queued.push(data);
			this.#queued.set(channel, queued);
			return;
		}
		for (const listener of [...listeners]) listener(data);
	}
}
