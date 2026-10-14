/**
 * The preview's side of stock omp's browser relay (`tools/browser/relay/`).
 *
 * Stock's relay server impersonates Chrome's CDP endpoint for the agent's
 * browser tool and drives "tabs" through a companion Chrome extension that
 * owns `chrome.debugger`. Here the preview WebContentsView plays that
 * extension: one tab, Electron's `webContents.debugger` (the same per-page
 * DevTools agent `chrome.debugger` wraps) in place of chrome.debugger. The
 * browser-level CDP facade, target bookkeeping and session routing stay
 * stock's (RelayBridge); this file only speaks the extension wire protocol
 * (`relay/protocol.ts`), mirroring stock's `extension-assets/background.js`.
 *
 * Safety (AGENTS.md Preview rules): the page keeps its non-persistent sandboxed
 * partition with no preload; the agent only ever reaches this one page, never
 * the app window. Commands that would leave http(s) or touch the browser,
 * downloads or other targets are refused here, before the page sees them.
 */
import type { Debugger } from "electron";
import { z } from "zod";
import { previewUrl } from "../../shared/preview";

/** Stock's `DISCARDED_TABS_PROTOCOL_VERSION`: required for the relay to list our tab. */
const DISCARDED_TABS_PROTOCOL = 1;

/** The slice of Electron's per-page debugger the relay drives. */
export type RelayDebugger = Pick<Debugger, "attach" | "detach" | "isAttached" | "sendCommand" | "on" | "off">;

/** A relay → extension RPC (stock `RelayToExtMessage` with `t: "rpc"`). */
const relayRpc = z.object({
	t: z.literal("rpc"),
	id: z.number(),
	op: z.string(),
	tabId: z.number().optional(),
	sessionId: z.string().optional(),
	method: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
type RelayRpc = z.infer<typeof relayRpc>;
/** The preview page as the relay sees it. */
export interface RelayPage {
	/** Stable numeric tab id (the preview webContents id). */
	readonly id: number;
	url(): string;
	title(): string;
	userAgent(): string;
	readonly debugger: RelayDebugger;
	/** Give a never-loaded page a renderer (about:blank): page-domain commands wait forever without one. */
	ensureRenderer(): Promise<void>;
}

/** Stock's `TabSnapshot`. */
interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	discarded: boolean;
	windowId: number;
	pinned: boolean;
	groupId: number;
}

/** Methods the agent may not send to the page: browser-wide, other targets, downloads. */
const REFUSED_METHODS: Record<string, true> = {
	"Page.setDownloadBehavior": true,
	"Target.createTarget": true,
	"Target.createBrowserContext": true,
	"Target.disposeBrowserContext": true,
	"Target.exposeDevToolsProtocol": true,
	"Target.closeTarget": true,
};
const REFUSED_DOMAINS = ["Browser.", "SystemInfo.", "Tethering.", "Tracing."];

/**
 * Why the preview refuses `method` with `params`, or null to forward it.
 * Navigation is checked here because a CDP `Page.navigate` is browser-initiated
 * and skips the preview's `will-frame-navigate` guard.
 */
export function refusedCommand(method: string, params: unknown): string | null {
	if (REFUSED_METHODS[method] || REFUSED_DOMAINS.some(domain => method.startsWith(domain))) {
		return `OMPdesk's preview does not allow ${method}`;
	}
	if (method === "Page.navigate") {
		const url = params && typeof params === "object" && "url" in params ? params.url : undefined;
		if (typeof url !== "string" || (url !== "about:blank" && !previewUrl(url))) {
			return "OMPdesk's preview only opens http(s) pages";
		}
	}
	return null;
}

/** Plays stock's relay extension for one preview page over an established socket. */
export class PreviewRelayExtension {
	readonly #page: RelayPage;
	readonly #post: (message: object) => void;
	readonly #onActivity: (method: string) => void;
	#relayDetaching = false;
	#disposed = false;

	readonly #onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
		this.#post({ t: "cdpEvent", tabId: this.#page.id, ...(sessionId ? { sessionId } : {}), method, params });
	};

	readonly #onDetach = (_event: unknown, reason: string) => {
		const relayInitiated = this.#relayDetaching;
		this.#relayDetaching = false;
		this.#post({ t: "detached", tabId: this.#page.id, reason, relayInitiated });
		this.#onActivity("");
	};

	constructor(page: RelayPage, post: (message: object) => void, onActivity: (method: string) => void) {
		this.#page = page;
		this.#post = post;
		this.#onActivity = onActivity;
		page.debugger.on("message", this.#onMessage);
		page.debugger.on("detach", this.#onDetach);
	}

	/** True while the agent holds the page's debugger. */
	get attached(): boolean {
		return !this.#disposed && this.#page.debugger.isAttached();
	}

	snapshot(): TabSnapshot {
		return {
			tabId: this.#page.id,
			url: this.#page.url(),
			title: this.#page.title(),
			active: true,
			discarded: false,
			windowId: 1,
			pinned: false,
			groupId: -1,
		};
	}

	/** The extension's first message: our single tab, and whether a debugger is already ours. */
	hello(instanceId: string): object {
		const version = /Chrome\/[\d.]+/.exec(this.#page.userAgent());
		return {
			t: "hello",
			instanceId,
			userAgent: this.#page.userAgent(),
			browserVersion: version?.[0] ?? "Chrome/unknown",
			discardedTabsProtocol: DISCARDED_TABS_PROTOCOL,
			tabs: [this.snapshot()],
			attachedTabIds: this.attached ? [this.#page.id] : [],
		};
	}

	/** The page navigated or retitled. */
	pageUpdated(): void {
		this.#post({ t: "tabUpdated", tab: this.snapshot() });
	}

	/** One relay → extension frame. */
	handle(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		// `pong` and anything unknown are not RPCs.
		const message = relayRpc.safeParse(parsed);
		if (!message.success) return;
		const rpc = message.data;
		this.#run(rpc).then(
			result => this.#post({ t: "rpcResult", id: rpc.id, ok: true, result }),
			(error: unknown) =>
				this.#post({
					t: "rpcResult",
					id: rpc.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	}

	async #run(rpc: RelayRpc): Promise<object> {
		if (this.#disposed) throw new Error("The preview stopped sharing this page");
		const debuggerApi = this.#page.debugger;
		if (rpc.tabId !== undefined && rpc.tabId !== this.#page.id && rpc.op !== "group" && rpc.op !== "ungroup") {
			throw new Error(`No preview tab ${String(rpc.tabId)}`);
		}
		switch (rpc.op) {
			case "attach":
				await this.#page.ensureRenderer();
				if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
				this.#onActivity("attach");
				return {};
			case "detach":
				if (debuggerApi.isAttached()) {
					this.#relayDetaching = true;
					debuggerApi.detach();
				}
				return {};
			case "send": {
				const method = rpc.method ?? "";
				const refused = refusedCommand(method, rpc.params);
				if (refused) throw new Error(refused);
				this.#onActivity(method);
				const result: unknown = await debuggerApi.sendCommand(method, rpc.params, rpc.sessionId);
				return result && typeof result === "object" ? result : {};
			}
			case "activateTab":
				return {};
			case "group":
				// Chrome tab groups have no preview counterpart; nothing is grouped.
				return { grouped: {} };
			case "ungroup":
				return {};
			case "createTab":
				throw new Error("OMPdesk's preview is a single page: navigate it instead of opening a tab");
			case "removeTab":
				throw new Error("OMPdesk's preview stays open; the user closes it");
			default:
				throw new Error(`Unknown relay operation ${rpc.op}`);
		}
	}

	/** Release the debugger and stop forwarding (take over, stop, or the relay went away). */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const debuggerApi = this.#page.debugger;
		debuggerApi.off("message", this.#onMessage);
		debuggerApi.off("detach", this.#onDetach);
		if (debuggerApi.isAttached()) {
			try {
				debuggerApi.detach();
			} catch {
				// Already detached by the page going away.
			}
		}
	}
}

/**
 * The relay endpoint the bridge returned, accepted only as stock's loopback
 * relay (`http://127.0.0.1:<port>`) with a token; anything else is refused so
 * the preview never dials elsewhere.
 */
export function relayExtensionUrl(url: string, token: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) return null;
	if (parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search || parsed.username || parsed.password) return null;
	if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return null;
	return `ws://127.0.0.1:${parsed.port}/ext?token=${token}`;
}
