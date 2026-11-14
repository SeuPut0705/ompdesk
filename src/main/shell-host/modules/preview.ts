/**
 * Node's client of the shell's `preview` module (PROTOCOL.md §15.6, slice SX2). The Preview's pages, their rules, the
 * phone's stream, the agent's relay extension and `gui_visualize` run in the shell; Node keeps what only it can do:
 * the `PREVIEW_*` IPC handlers (their callers, the policy table), the relay's socket (stock's loopback relay, or the
 * tunnel over the link to a paired host's), the save dialog, `PREVIEW_STATE`/`PREVIEW_VISUAL` to the owner's window,
 * and the tab's omp that judges a visual's page.
 *
 * An **owner** is the page that asked: an app window's renderer (`key` its `webContents.id`, `winId` the window) or
 * a paired viewer's virtual window (`key` its negative id). `remote` (the owner's tab runs on a paired host) goes with
 * every command that may navigate, as `ipc.ts` computed it before the move.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as electron from "electron";
import { z } from "zod";
import {
	EMPTY_PREVIEW,
	PREVIEW_COMMAND,
	PREVIEW_PAGE,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_STREAM_COPY,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_PDF,
	PREVIEW_STREAM_POLL,
	PREVIEW_VISUAL,
	PREVIEW_VISUALS,
	type PreviewPageRequest,
	type PreviewRequest,
	type PreviewState,
	type PreviewStreamInput,
	type PreviewStreamPoll,
	type PreviewVisualEvent,
	type PreviewVisualRecord,
} from "../../../shared/preview";
import type { RpcClient } from "../../rpc-client";
import { type ClientWindow, isWebWindow } from "../../web/client-window";
import type { IpcCaller, IpcRegistry } from "../../web/ipc-registry";
import { type ModuleClient, shellModule } from "./client";

/** The page that asked (§15.6): an app window's renderer, or a paired viewer's virtual window. */
export interface PreviewOwner {
	key: number;
	winId?: number;
}

export interface PreviewImage {
	data: string;
	mimeType: string;
}

/** The module's wire, as PROTOCOL.md §15.6 lists it. */
export interface PreviewSpec {
	calls: {
		command: {
			params: { owner: PreviewOwner; remote: boolean; request: Exclude<PreviewRequest, { action: "agentStart" }> };
			result: PreviewState;
		};
		agentStart: { params: { owner: PreviewOwner; remote: boolean; tabId: string }; result: PreviewState };
		agentReady: { params: { owner: PreviewOwner }; result: PreviewState };
		page: { params: { owner: PreviewOwner; request: PreviewPageRequest }; result: unknown };
		pdfName: { params: { owner: PreviewOwner }; result: { name: string } };
		pdf: { params: { owner: PreviewOwner; maxBytes?: number }; result: Record<string, never> };
		visuals: { params: Record<string, never>; result: PreviewVisualRecord[] };
		poll: { params: { owner: PreviewOwner; ack: number | null; wait?: number }; result: PreviewStreamPoll };
		dialogAnswer: {
			params: { owner: PreviewOwner; id: number; accept: boolean; text?: string };
			result: Record<string, never>;
		};
		copy: { params: { owner: PreviewOwner }; result: { text: string } };
		visualize: {
			params: { tabId: string; cwd: string; winId: number; judge: boolean; inFront: boolean; args: unknown };
			result: { text: string; isError: boolean };
		};
	};
	posts: {
		relayIn: { owner: PreviewOwner; data: string };
		relayClosed: { owner: PreviewOwner };
		ownerGone: { owner: PreviewOwner };
		input: { owner: PreviewOwner; events: PreviewStreamInput[] };
	};
	events: {
		relayOut: { owner: PreviewOwner; data: string };
		relayEnd: { owner: PreviewOwner };
		state: { owner: PreviewOwner; state: PreviewState };
		reveal: { tabId: string; visualId: string };
	};
	asks: {
		judgeAvailable: { params: { tabId: string; budgetMs: number }; result: { available: boolean } };
		judge: {
			params: { tabId: string; image: PreviewImage; budgetMs: number };
			result: { judged: boolean; problem: "error" | "blank" | null };
		};
	};
}

export type PreviewModule = ModuleClient<PreviewSpec>;

// ------------------------------------------------------------------------------------------------ the relay's socket

/**
 * The agent's relay as the client sees it: one text-frame socket to stock's browser relay. A tab on this computer
 * dials the relay's loopback address (`localRelaySocket`); a tab on a paired host reaches the relay over the link
 * (`LinkRelaySocket`, remote/link-relay-socket.ts). `agentStart` runs the same code over either.
 */
export interface RelaySocket {
	/** Resolves once frames may be sent; rejects when the relay cannot be reached or closes first. */
	readonly ready: Promise<void>;
	readonly isOpen: boolean;
	send(data: string): void;
	close(): void;
	onMessage(listener: (data: string) => void): void;
	onClose(listener: () => void): void;
}

/** A tab on this computer: stock's relay on its loopback port (`relayExtensionUrl` has vetted `target`). */
export function localRelaySocket(target: string): RelaySocket {
	const socket = new WebSocket(target);
	const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
	// Nobody may be awaiting `ready` when it rejects (the socket closes before agentStart's await returns).
	ready.catch(() => {});
	socket.addEventListener("open", () => resolve(), { once: true });
	socket.addEventListener("error", () => reject(new Error("The browser relay did not answer")), { once: true });
	socket.addEventListener("close", () => reject(new Error("The browser relay closed")), { once: true });
	return {
		ready,
		get isOpen() {
			return socket.readyState === WebSocket.OPEN;
		},
		send: data => socket.send(data),
		close: () => socket.close(),
		onMessage: listener => socket.addEventListener("message", message => listener(String(message.data))),
		onClose: listener => socket.addEventListener("close", () => listener()),
	};
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

// ----------------------------------------------------------------------------------------------------- IPC handlers

/** Longest hold of a viewer's poll, and the largest PDF and most input events one call carries. */
const POLL_MAX_WAIT_MS = 20_000;
const PDF_MAX_BYTES = 5 * 1024 * 1024;
const INPUT_BATCH_MAX = 64;

const pollRequestSchema = z.object({
	ack: z.number().int().nonnegative().nullable(),
	wait: z.number().int().min(0).max(POLL_MAX_WAIT_MS).optional(),
});
const dialogAnswerSchema = z.object({
	id: z.number().int().positive(),
	accept: z.boolean(),
	text: z.string().max(2000).nullish(),
});
const selector = z.string().min(1).max(2000);
const pageRequestSchema: z.ZodType<PreviewPageRequest> = z.discriminatedUnion("action", [
	z.object({ action: z.enum(["pick", "region", "cancel", "tweaks", "clearVariables"]) }),
	z.object({ action: z.enum(["parent", "highlight"]), selector }),
	z.object({
		action: z.literal("pins"),
		pins: z.array(z.object({ n: z.number().int().min(1), selector })).max(100),
	}),
	z.object({
		action: z.literal("setVariable"),
		name: z.string().regex(/^--[\w-]+$/),
		value: z.string().max(500),
	}),
]);

/** What the handlers need of the rest of main. */
export interface PreviewDeps {
	/** The pool's `tabTarget`: where `tabId` (default the window's active tab) runs; null for a tab the window does not own. */
	tabTarget(win: ClientWindow, tabId?: string): { device?: string | undefined } | null;
	/** A paired host's tab's relay over the link (`remoteDevices.previewRelay`); null when the tab is not on a paired host. */
	tunnel(win: ClientWindow, tabId?: string): RelaySocket | null;
	/** The `judgeAssist` pref. */
	judgeAssist(): boolean;
	/** The tab the window shows. */
	activeTab(win: ClientWindow): string | null;
	/** The app window as `BrowserWindow.id`, for a dialog's owner and the module's `winId`; absent for a viewer's. */
	appWindowId?(win: ClientWindow): number | undefined;
}

/** The tab that runs `gui_visualize`: its window, and its omp (null while it is not running). */
export interface VisualizeTab {
	tabId: string;
	cwd: string;
	win: ClientWindow;
	rpc: Pick<RpcClient, "command"> | null;
}

export interface PreviewClient {
	/** One `gui_visualize` call of a tab on this computer; the page work, the visual store and the check run in the shell. */
	visualize(tab: VisualizeTab, args: unknown): Promise<{ text: string; isError: boolean }>;
}

/** Everything one owner has in Node: the window to tell, the relay's socket, and what ends the owner. */
interface OwnerEntry {
	owner: PreviewOwner;
	win: ClientWindow;
	socket: RelaySocket | null;
	unwatch: () => void;
}

interface Resolved {
	owner: PreviewOwner;
	win: ClientWindow;
	/** The app window's own object (a dialog sheet's parent, the renderer whose navigation ends the preview); null for a viewer. */
	browserWindow: IpcCaller["browserWindow"];
	viewer: boolean;
}

/**
 * Registers the `PREVIEW_*` handlers on `ipc`, serves the module's asks, forwards its events and returns the
 * `gui_visualize` entry point. `module` is the real client by default; a test passes one over a test shell.
 */
export function registerPreview(
	ipc: IpcRegistry,
	deps: PreviewDeps,
	module: PreviewModule = shellModule<PreviewSpec>("preview"),
): PreviewClient {
	const entries = new Map<number, OwnerEntry>();
	const tabs = new Map<string, VisualizeTab>();

	const remoteOf = (win: ClientWindow, tabId?: string): boolean => {
		const target = deps.tabTarget(win, tabId);
		// A named tab this window does not own counts as remote: agent browsing refuses it.
		return tabId ? !target || Boolean(target.device) : Boolean(target?.device);
	};

	/** Who a preview call is for: the app window that asked, or a paired viewer's virtual window. */
	const resolve = (caller: IpcCaller): Resolved => {
		const browserWindow = caller.browserWindow;
		if (browserWindow) {
			if (browserWindow.webContents !== (caller.sender as unknown)) throw new Error("Invalid preview owner");
			return {
				owner: { key: browserWindow.webContents.id, winId: browserWindow.id },
				win: browserWindow,
				browserWindow,
				viewer: false,
			};
		}
		const viewer = caller.win;
		if (!viewer || !isWebWindow(viewer.webContents.id)) throw new Error("Invalid preview owner");
		return { owner: { key: viewer.webContents.id }, win: viewer, browserWindow: null, viewer: true };
	};

	const closeSocket = (entry: OwnerEntry) => {
		const socket = entry.socket;
		entry.socket = null;
		socket?.close();
	};

	/** The owner's pages are gone (or going): its window, renderer or viewer is what ends them. */
	const forget = (entry: OwnerEntry) => {
		entry.unwatch();
		closeSocket(entry);
		if (entries.get(entry.owner.key) === entry) entries.delete(entry.owner.key);
	};
	const gone = (entry: OwnerEntry) => {
		if (entries.get(entry.owner.key) !== entry) return;
		forget(entry);
		void module.post("ownerGone", { owner: entry.owner });
	};

	const entryOf = (found: Resolved): OwnerEntry => {
		const known = entries.get(found.owner.key);
		if (known) return known;
		const { win, browserWindow } = found;
		const onClosed = () => gone(entry);
		// Only the app renderer's own page load ends the preview, not a frame in it or an in-page change.
		const onNavigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
			if (details.isMainFrame && !details.isSameDocument) gone(entry);
		};
		const entry: OwnerEntry = {
			owner: found.owner,
			win,
			socket: null,
			unwatch: () => {
				browserWindow?.off("closed", onClosed);
				browserWindow?.webContents.off("did-start-navigation", onNavigated);
				win.removeListener("closed", onClosed);
			},
		};
		entries.set(found.owner.key, entry);
		if (browserWindow) {
			browserWindow.on("closed", onClosed);
			browserWindow.webContents.on("did-start-navigation", onNavigated);
		} else {
			// A revoked device's window closes: its pages go with it.
			win.once("closed", onClosed);
		}
		return entry;
	};

	module.on("state", ({ owner, state }) => {
		const win = entries.get(owner.key)?.win;
		if (win && !win.isDestroyed()) win.webContents.send(PREVIEW_STATE, state);
	});
	module.on("relayOut", ({ owner, data }) => {
		const socket = entries.get(owner.key)?.socket;
		if (socket?.isOpen) socket.send(data);
	});
	module.on("relayEnd", ({ owner }) => {
		const entry = entries.get(owner.key);
		if (entry) closeSocket(entry);
	});
	module.on("reveal", ({ tabId, visualId }) => {
		const win = tabs.get(tabId)?.win;
		if (win && !win.isDestroyed())
			win.webContents.send(PREVIEW_VISUAL, { tabId, visualId } satisfies PreviewVisualEvent);
	});
	module.serve("judgeAvailable", async ({ tabId, budgetMs }) => {
		const response = await tabs.get(tabId)?.rpc?.command({ type: "judge_available" }, budgetMs);
		return {
			available:
				response?.success === true && (response.data as { available?: unknown } | undefined)?.available === true,
		};
	});
	module.serve("judge", async ({ tabId, image, budgetMs }) => {
		const response = await tabs.get(tabId)?.rpc?.command({ type: "judge_preview_check", image }, budgetMs);
		if (!response?.success) return { judged: false, problem: null };
		const data = response.data as { problem?: unknown; judged?: unknown } | undefined;
		const problem = data?.problem === "error" || data?.problem === "blank" ? data.problem : null;
		return { judged: data?.judged === true, problem };
	});

	/**
	 * Agent browsing: the endpoint is vetted here and the socket opened here (Node is the one with a network and a link
	 * to a paired host); the module's page then gets the relay's extension and speaks through `relayIn`/`relayOut`.
	 */
	const agentStart = async (found: Resolved, entry: OwnerEntry, tabId: string, url: string, token: string) => {
		const target = relayExtensionUrl(url, token);
		if (!target) throw new Error("Invalid browser relay endpoint");
		closeSocket(entry);
		// A paired host's tab runs its agent there: its relay listens on the host's loopback, so the relay's frames
		// cross the link, and the page the agent drives is still this one. The target above is the host's, not dialed here.
		const remote = remoteOf(found.win, tabId);
		const socket = remote ? deps.tunnel(found.win, tabId) : localRelaySocket(target);
		if (!socket) throw new Error("Agent browsing is not available for this tab");
		const { owner } = entry;
		entry.socket = socket;
		socket.onMessage(data => {
			if (entry.socket === socket) void module.post("relayIn", { owner, data });
		});
		socket.onClose(() => {
			if (entry.socket !== socket) return;
			entry.socket = null;
			void module.post("relayClosed", { owner });
		});
		const abandon = () => {
			if (entry.socket !== socket) return;
			entry.socket = null;
			socket.close();
		};
		try {
			await module.call("agentStart", { owner, remote, tabId });
		} catch (error) {
			// Refused before an agent existed (a visual's page): nothing to stop in the module.
			abandon();
			throw error;
		}
		try {
			await socket.ready;
		} catch (error) {
			if (entry.socket === socket) {
				entry.socket = null;
				socket.close();
			}
			await module.post("relayClosed", { owner });
			throw error;
		}
		// Taken back, or another page shown, while the relay was being reached: the module knows.
		return module.call("agentReady", { owner });
	};

	ipc.handle(PREVIEW_COMMAND, async (caller, raw: unknown) => {
		const request = raw as PreviewRequest;
		const found = resolve(caller);
		if (request.action === "dispose") {
			const entry = entries.get(found.owner.key);
			await module.call("command", { owner: found.owner, remote: false, request });
			if (entry) forget(entry);
			return EMPTY_PREVIEW;
		}
		const entry = entryOf(found);
		if (request.action === "agentStart") return agentStart(found, entry, request.tabId, request.url, request.token);
		const tabId = "tabId" in request ? request.tabId : undefined;
		return module.call("command", { owner: found.owner, remote: remoteOf(found.win, tabId), request });
	});

	ipc.handle(PREVIEW_SAVE_PDF, async caller => {
		const found = resolve(caller);
		const win = found.browserWindow;
		if (!win) throw new Error("Invalid preview owner");
		const { name } = await module.call("pdfName", { owner: found.owner });
		const choice = await electron.dialog.showSaveDialog(win, {
			defaultPath: path.join(electron.app.getPath("downloads"), `${name}.pdf`),
			filters: [{ name: "PDF", extensions: ["pdf"] }],
		});
		if (choice.canceled || !choice.filePath) return null;
		const { bin } = await module.request("pdf", { owner: found.owner });
		if (!bin) throw new Error("No page to save");
		await writeFile(choice.filePath, bin);
		return choice.filePath;
	});
	ipc.handle(PREVIEW_VISUALS, () => module.call("visuals", {}));
	ipc.handle(PREVIEW_PAGE, async (caller, raw: unknown) => {
		const request = pageRequestSchema.parse(raw);
		return (await module.call("page", { owner: resolve(caller).owner, request })) ?? null;
	});

	/** A web viewer's owner, or a refusal: an app window has no stream. */
	const streamOwner = (caller: IpcCaller): PreviewOwner => {
		const found = resolve(caller);
		if (!found.viewer) throw new Error("No streamed preview page");
		return found.owner;
	};
	ipc.handle(PREVIEW_STREAM_POLL, (caller, raw: unknown) => {
		const request = pollRequestSchema.parse(raw);
		return module.call("poll", {
			owner: streamOwner(caller),
			ack: request.ack,
			...(request.wait === undefined ? {} : { wait: request.wait }),
		});
	});
	ipc.on(PREVIEW_STREAM_INPUT, (caller, raw: unknown) => {
		if (!Array.isArray(raw) || raw.length > INPUT_BATCH_MAX) return;
		let owner: PreviewOwner;
		try {
			owner = streamOwner(caller);
		} catch {
			return;
		}
		void module.post("input", { owner, events: raw as PreviewStreamInput[] });
	});
	ipc.handle(PREVIEW_STREAM_DIALOG, async (caller, raw: unknown) => {
		const { id, accept, text } = dialogAnswerSchema.parse(raw);
		await module.call("dialogAnswer", { owner: streamOwner(caller), id, accept, ...(text ? { text } : {}) });
	});
	ipc.handle(PREVIEW_STREAM_COPY, async caller => (await module.call("copy", { owner: streamOwner(caller) })).text);
	ipc.handle(PREVIEW_STREAM_PDF, async caller => {
		const owner = streamOwner(caller);
		const { name } = await module.call("pdfName", { owner });
		const { bin } = await module.request("pdf", { owner, maxBytes: PDF_MAX_BYTES });
		if (!bin) throw new Error("No page to save");
		return { name: `${name}.pdf`, base64: bin.toString("base64") };
	});

	return {
		async visualize(tab, args) {
			const previous = tabs.get(tab.tabId);
			tabs.set(tab.tabId, tab);
			try {
				const winId = deps.appWindowId?.(tab.win) ?? tab.win.webContents.id;
				return await module.call("visualize", {
					tabId: tab.tabId,
					cwd: tab.cwd,
					winId,
					judge: deps.judgeAssist(),
					// The renderer opens the Preview only for the tab in front (stores/preview-visuals.ts).
					inFront: deps.activeTab(tab.win) === tab.tabId,
					args,
				});
			} finally {
				if (tabs.get(tab.tabId) === tab) {
					if (previous) tabs.set(tab.tabId, previous);
					else tabs.delete(tab.tabId);
				}
			}
		},
	};
}
