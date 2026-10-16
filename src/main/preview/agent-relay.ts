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
 * the app window. Electron's per-page debugger can reach other targets
 * (`Target.attachToTarget` onto the app window answers `Runtime.evaluate`
 * there), so only an allowlist of page domains is forwarded, and only to
 * sessions this page's own debugger announced (its frames and workers).
 * Navigation off http(s), downloads, file pickers and other targets are
 * refused here, before the page sees them.
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

/**
 * CDP domains the agent may drive on the page: what stock's browser tool (puppeteer) uses
 * against one page. Everything else is refused, so a new or browser-wide domain stays off
 * until it is listed here. `Browser`, `SystemInfo`, `Tethering`, `Tracing` and `Memory`
 * are deliberately absent; `Target` has its own two-method list below.
 */
const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
	"Accessibility",
	"Animation",
	"Audits",
	"CSS",
	"Console",
	"DOM",
	"DOMDebugger",
	"DOMSnapshot",
	"DOMStorage",
	"Debugger",
	"Emulation",
	"Fetch",
	"HeapProfiler",
	"IO",
	"Input",
	"Inspector",
	"Log",
	"Media",
	"Network",
	"Overlay",
	"Page",
	"Performance",
	"PerformanceTimeline",
	"Profiler",
	"Runtime",
	"Security",
	"ServiceWorker",
	"Storage",
]);

/**
 * The only `Target.` methods forwarded: the page arms auto-attach over its own frames and
 * workers, and drops one of those sessions again. Electron's per-page debugger does not
 * confine `Target.getTargets` / `attachToTarget` to the page (an attach to the app window
 * answers `Runtime.evaluate` there), so every other Target method stays refused.
 */
const ALLOWED_TARGET_METHODS: ReadonlySet<string> = new Set(["Target.setAutoAttach", "Target.detachFromTarget"]);

/** Inside an allowed domain, methods that still reach beyond the page: its tab, files, downloads, TLS. */
const REFUSED_METHODS: ReadonlySet<string> = new Set([
	"DOM.setFileInputFiles",
	"Input.setInterceptDrags",
	"Page.close",
	"Page.crash",
	"Page.setDownloadBehavior",
	"Page.setInterceptFileChooserDialog",
	"Security.handleCertificateError",
	"Security.setIgnoreCertificateErrors",
	"Security.setOverrideCertificateErrors",
]);

/** Domains refused with their own reason instead of the generic one, so the agent's tool error says why. */
const DOMAIN_REASONS: Readonly<Record<string, string>> = {
	Tracing:
		"OMPdesk's preview does not allow Tracing (tab.traceStart): a trace is browser-wide and would record the app's other windows. Use Performance or Profiler on this page instead",
};

/** Whether the preview may show `url`: `about:blank` or an http(s) page (the rule every navigation shares). */
function navigableUrl(url: unknown): boolean {
	return typeof url === "string" && (url === "about:blank" || previewUrl(url) !== null);
}

/** `Input.DragData` that hands the page files: `files` paths, or an item naming a `file:` URL. */
function dragCarriesFiles(data: unknown): boolean {
	if (!data || typeof data !== "object") return false;
	if ("files" in data && data.files !== undefined && !(Array.isArray(data.files) && data.files.length === 0)) {
		return true;
	}
	const items = "items" in data ? data.items : undefined;
	if (!Array.isArray(items)) return false;
	return items.some(
		item =>
			item &&
			typeof item === "object" &&
			Object.values(item).some(value => typeof value === "string" && /^\s*file:/im.test(value)),
	);
}

/** Announced targets that are not children of this page (a session onto them is never relayed). */
const FOREIGN_TARGET_TYPES: ReadonlySet<string> = new Set(["page", "tab", "browser"]);

/**
 * Why the preview refuses `method` with `params`, or null to forward it.
 * Navigation is checked here because a CDP `Page.navigate` is browser-initiated
 * and skips the preview's `will-frame-navigate` guard. Which session a command
 * addresses is checked by `PreviewRelayExtension`, which sees the page's events.
 */
export function refusedCommand(method: string, params: unknown): string | null {
	const domain = method.slice(0, Math.max(method.indexOf("."), 0));
	const allowed = domain === "Target" ? ALLOWED_TARGET_METHODS.has(method) : ALLOWED_DOMAINS.has(domain);
	if (!allowed || REFUSED_METHODS.has(method)) {
		return Object.hasOwn(DOMAIN_REASONS, domain)
			? DOMAIN_REASONS[domain]!
			: `OMPdesk's preview does not allow ${method}`;
	}
	const named = params && typeof params === "object" ? params : {};
	if (method === "Page.navigate" && !navigableUrl("url" in named ? named.url : undefined)) {
		return "OMPdesk's preview only opens http(s) pages";
	}
	// DevTools' resource loader (source maps): only what the page could fetch from the web, never a local file.
	if (method === "Network.loadNetworkResource") {
		const url = "url" in named ? named.url : undefined;
		if (typeof url !== "string" || previewUrl(url) === null) {
			return "OMPdesk's preview only loads http(s) resources";
		}
	}
	// The target URL is read from the page's own history before the command goes out (see `#historyRefusal`).
	if (method === "Page.navigateToHistoryEntry" && !("entryId" in named && Number.isInteger(named.entryId))) {
		return "OMPdesk's preview needs a history entry id to navigate";
	}
	if (method === "Input.dispatchDragEvent" && "data" in named && dragCarriesFiles(named.data)) {
		return "OMPdesk's preview does not allow dropping files onto the page";
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
	/** Sessions this page's own debugger announced (its frames and workers); nothing else is addressable. */
	readonly #sessions = new Set<string>();

	readonly #onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
		this.#trackSessions(method, params);
		this.#post({ t: "cdpEvent", tabId: this.#page.id, ...(sessionId ? { sessionId } : {}), method, params });
	};

	readonly #onDetach = (_event: unknown, reason: string) => {
		const relayInitiated = this.#relayDetaching;
		this.#relayDetaching = false;
		this.#sessions.clear();
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

	#trackSessions(method: string, params: unknown): void {
		if (method !== "Target.attachedToTarget" && method !== "Target.detachedFromTarget") return;
		if (!params || typeof params !== "object" || !("sessionId" in params) || typeof params.sessionId !== "string")
			return;
		if (method === "Target.detachedFromTarget") {
			this.#sessions.delete(params.sessionId);
			return;
		}
		const info = "targetInfo" in params ? params.targetInfo : undefined;
		const type = info && typeof info === "object" && "type" in info ? info.type : undefined;
		if (typeof type === "string" && !FOREIGN_TARGET_TYPES.has(type)) this.#sessions.add(params.sessionId);
	}

	/** Why the preview refuses to address `sessionId` (and the session `params` name), or null. */
	#refusedSession(method: string, params: unknown, sessionId: string | undefined): string | null {
		if (sessionId !== undefined && !this.#sessions.has(sessionId)) {
			return "OMPdesk's preview only reaches this page's own frames and workers";
		}
		if (method === "Target.detachFromTarget") {
			const named = params && typeof params === "object" && "sessionId" in params ? params.sessionId : undefined;
			if (typeof named !== "string" || !this.#sessions.has(named)) {
				return "OMPdesk's preview only detaches this page's own frames and workers";
			}
		}
		return null;
	}

	/**
	 * Why `Page.navigateToHistoryEntry` may not go to its entry, or null. Stock's `tab.back()`/`tab.forward()`
	 * (puppeteer `goBack`/`goForward`) read `Page.getNavigationHistory` and then jump to an entry id, so the
	 * entry's URL is looked up here and held to the rule every other navigation follows.
	 */
	async #historyRefusal(params: unknown, sessionId: string | undefined): Promise<string | null> {
		const entryId = params && typeof params === "object" && "entryId" in params ? params.entryId : undefined;
		const history: unknown = await this.#page.debugger.sendCommand("Page.getNavigationHistory", undefined, sessionId);
		const entries = history && typeof history === "object" && "entries" in history ? history.entries : undefined;
		const entry = Array.isArray(entries)
			? entries.find(candidate => candidate && typeof candidate === "object" && candidate.id === entryId)
			: undefined;
		if (!navigableUrl(entry?.url)) return "OMPdesk's preview only opens http(s) pages";
		return null;
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
				const refused =
					refusedCommand(method, rpc.params) ?? this.#refusedSession(method, rpc.params, rpc.sessionId);
				if (refused) throw new Error(refused);
				if (method === "Page.navigateToHistoryEntry") {
					const historyRefused = await this.#historyRefusal(rpc.params, rpc.sessionId);
					if (historyRefused) throw new Error(historyRefused);
				}
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
