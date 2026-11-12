/**
 * `WebContents` over the host protocol (PROTOCOL.md §4): a page of the shell with Electron's methods and events.
 * State the app reads synchronously (`getURL`, `isLoading`, `getTitle`, zoom, history flags) is mirrored from the
 * shell's `wc.state` pushes; what cannot be mirrored is a request. `capturePage`, `printToPDF`, `sendInputEvent`,
 * `insertText`, `executeJavaScriptInIsolatedWorld` and the `debugger` are built on the DevTools protocol.
 */
import { EventEmitter } from "node:events";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { WcState } from "../facts";
import { encodeBin } from "./binary-json";
import { emitPreventable, type Host, makeEvent, type PageRecord } from "./host";
import { type InputEvent, inputCommands } from "./input-events";
import { frameSource, NativeImage } from "./native-image";
import { DEFAULT_PARTITION, type Session } from "./session";

/** The events whose first argument is a details object that is also the Electron event (`details.url`). */
const DETAILED_EVENTS = new Set(["console-message", "did-start-navigation"]);

/** Events the shell only produces for a page that has a listener: the page is told once one is added. */
const WATCHED_EVENTS = new Set([
	"context-menu",
	"input-event",
	"console-message",
	"paint",
	"will-navigate",
	"will-frame-navigate",
	"will-redirect",
]);

export interface WindowOpenDetails {
	url: string;
	frameName: string;
	features: string;
	disposition: string;
	referrer?: { url: string; policy: string };
}

export type WindowOpenHandler = (details: WindowOpenDetails) => { action: "allow" | "deny" };

export class Debugger extends EventEmitter {
	readonly #contents: WebContents;
	#attached = false;

	constructor(contents: WebContents) {
		super();
		this.#contents = contents;
	}

	attach(_protocolVersion?: string): void {
		if (this.#attached) throw new Error("Another debugger is already attached to this WebContents.");
		this.#attached = true;
		this.#contents.post("wc.cdp.attach");
	}

	isAttached(): boolean {
		return this.#attached;
	}

	detach(): void {
		if (!this.#attached) return;
		this.#attached = false;
		this.#contents.post("wc.cdp.detach");
		this.emit("detach", makeEvent(), "target closed");
	}

	sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
		if (!this.#attached) return Promise.reject(new Error("Debugger is not attached to the target."));
		return this.#contents.cdp(method, params, sessionId);
	}

	/** The shell's `wc.cdp.message`. */
	deliver(method: string, params: unknown, sessionId: string | undefined): void {
		if (this.#attached) this.emit("message", makeEvent(), method, params, sessionId);
	}

	/** The shell's `wc.cdp.detached`: the page went away or DevTools took it. */
	detachedByShell(reason: string): void {
		if (!this.#attached) return;
		this.#attached = false;
		this.emit("detach", makeEvent(), reason);
	}
}

export interface WebContentsOptions {
	partition: string;
	/** The app window this page is the main page of; undefined for a view or an offscreen page. */
	windowId?: number;
	offscreen?: boolean;
	userAgent?: string;
}

/** Where `loadFile` finds the renderer the shell serves as `app://ompdesk/`. */
export function rendererRoot(facts: { appPath: string; rendererRoot?: string }): string {
	return facts.rendererRoot ?? join(facts.appPath, "out", "renderer");
}

export class WebContents extends EventEmitter implements PageRecord {
	readonly id: number;
	readonly windowId: number | undefined;
	readonly offscreen: boolean;
	readonly debugger: Debugger;
	readonly #host: Host;
	readonly #partition: string;
	#state: WcState;
	#destroyed = false;
	#windowOpenHandler: WindowOpenHandler | null = null;
	readonly #watching = new Set<string>();
	#loads: Array<{ resolve(): void; reject(error: Error): void }> = [];
	#sessionFor: (partition: string) => Session;

	constructor(host: Host, id: number, options: WebContentsOptions, sessionFor: (partition: string) => Session) {
		super();
		this.#host = host;
		this.id = id;
		this.windowId = options.windowId;
		this.offscreen = options.offscreen === true;
		this.#partition = options.partition;
		this.#sessionFor = sessionFor;
		this.#state = {
			url: "",
			title: "",
			loading: false,
			canGoBack: false,
			canGoForward: false,
			zoomFactor: 1,
			audioMuted: false,
			devtoolsOpened: false,
			crashed: false,
			userAgent: options.userAgent ?? "",
		};
		this.debugger = new Debugger(this);
		host.pages.set(id, this);
		this.on("newListener", name => {
			if (typeof name !== "string" || !WATCHED_EVENTS.has(name) || this.#watching.has(name)) return;
			this.#watching.add(name);
			this.op("watchEvents", { names: [...this.#watching] });
		});
	}

	/** A request to the shell about this page; a failure is logged (the caller has no use for it). */
	post(method: string, params: Record<string, unknown> = {}): void {
		this.#host.post(method, { wcId: this.id, ...params });
	}

	/** `wc.op`, not awaited. */
	op(op: string, args: Record<string, unknown> = {}): void {
		this.#host.post("wc.op", { wcId: this.id, op, args });
	}

	/** `wc.op`, awaited. */
	async opAsync<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		return this.#host.client.call<T>("wc.op", { wcId: this.id, op, args });
	}

	async cdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
		const answer = await this.#host.client.call<{ result: unknown }>("wc.cdp.send", {
			wcId: this.id,
			method,
			...(params === undefined ? {} : { params }),
			...(sessionId === undefined ? {} : { sessionId }),
		});
		return answer.result;
	}

	// --- the shell's pushes ---

	handleState(state: unknown): void {
		this.#state = { ...this.#state, ...(state as Partial<WcState>) };
	}

	handleEvent(name: string, args: unknown[]): void {
		if (name === "destroyed") {
			this.#destroy();
			return;
		}
		if (name === "paint") {
			const paint = args[0] as { width: number; height: number; scale?: number };
			const image = NativeImage.fromFrame(
				{ width: paint.width, height: paint.height },
				frameSource(this.#host.client, this.id),
			);
			this.emit("paint", makeEvent(), { x: 0, y: 0, width: paint.width, height: paint.height }, image);
			return;
		}
		if (name === "did-stop-loading" || name === "did-finish-load") this.#settleLoads(null);
		if (name === "did-fail-load" && args[3] === true && args[0] !== -3) {
			this.#settleLoads(
				new Error(`ERR_FAILED (${String(args[0])}) loading '${String(args[2])}': ${String(args[1])}`),
			);
		}
		if (DETAILED_EVENTS.has(name)) this.emit(name, makeEvent(args[0] as object));
		else this.emit(name, makeEvent(), ...args);
	}

	handleCdp(method: string, params: unknown, sessionId: string | undefined): void {
		this.debugger.deliver(method, params, sessionId);
	}

	handleCdpDetached(reason: string): void {
		this.debugger.detachedByShell(reason);
	}

	/** `wc.windowOpen`: the page asked to open a window; the app's handler decides (it only ever denies). */
	windowOpen(details: WindowOpenDetails): { action: "allow" | "deny" } {
		const decision = this.#windowOpenHandler?.(details) ?? { action: "deny" as const };
		return { action: decision.action === "allow" ? "allow" : "deny" };
	}

	/** `wc.navigate`: true when a listener prevented the navigation. */
	navigation(kind: string, details: Record<string, unknown>): boolean {
		const event = makeEvent(details);
		this.emit(kind, event, details.url, details.isSameDocument, details.isMainFrame);
		return event.defaultPrevented;
	}

	#settleLoads(error: Error | null): void {
		const loads = this.#loads;
		this.#loads = [];
		for (const load of loads) {
			if (error) load.reject(error);
			else load.resolve();
		}
	}

	#destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#state = { ...this.#state, loading: false };
		this.#settleLoads(new Error("The page was destroyed"));
		this.debugger.detachedByShell("target closed");
		this.emit("destroyed");
		this.#host.pages.delete(this.id);
	}

	// --- navigation and state ---

	loadURL(
		url: string,
		options: { userAgent?: string; httpReferrer?: string; extraHeaders?: string } = {},
	): Promise<void> {
		const loaded = new Promise<void>((resolve, reject) => this.#loads.push({ resolve, reject }));
		// A caller that does not await a failed load must not take the process down with an unhandled rejection.
		loaded.catch(() => undefined);
		this.op("loadURL", { url, ...options });
		return loaded;
	}

	/** The renderer the shell serves (`out/renderer/…` as `app://ompdesk/…`); any other file by its `file:` URL. */
	loadFile(filePath: string, options: { query?: Record<string, string>; hash?: string } = {}): Promise<void> {
		const root = rendererRoot(this.#host.facts);
		const inside = relative(root, filePath);
		const base =
			inside === "" || inside.startsWith("..") || inside.includes(":")
				? pathToFileURL(filePath)
				: new URL(`app://ompdesk/${inside.split(sep).map(encodeURIComponent).join("/")}`);
		for (const [key, value] of Object.entries(options.query ?? {})) base.searchParams.set(key, value);
		if (options.hash) base.hash = options.hash;
		return this.loadURL(base.toString());
	}

	reload(): void {
		this.op("reload");
	}

	reloadIgnoringCache(): void {
		this.op("reloadIgnoringCache");
	}

	stop(): void {
		this.op("stop");
	}

	getURL(): string {
		return this.#state.url;
	}

	getTitle(): string {
		return this.#state.title;
	}

	isLoading(): boolean {
		return this.#state.loading;
	}

	isDestroyed(): boolean {
		return this.#destroyed;
	}

	isCrashed(): boolean {
		return this.#state.crashed;
	}

	getUserAgent(): string {
		return this.#state.userAgent;
	}

	getZoomFactor(): number {
		return this.#state.zoomFactor;
	}

	setZoomFactor(factor: number): void {
		this.#state = { ...this.#state, zoomFactor: factor };
		this.op("setZoomFactor", { factor });
	}

	get navigationHistory() {
		return {
			canGoBack: () => this.#state.canGoBack,
			canGoForward: () => this.#state.canGoForward,
			goBack: () => this.op("goBack"),
			goForward: () => this.op("goForward"),
		};
	}

	get session(): Session {
		return this.#sessionFor(this.#partition);
	}

	setWindowOpenHandler(handler: WindowOpenHandler): void {
		this.#windowOpenHandler = handler;
	}

	setWebRTCIPHandlingPolicy(policy: string): void {
		this.op("setWebRTCIPHandlingPolicy", { policy });
	}

	setFrameRate(fps: number): void {
		this.op("setFrameRate", { fps });
	}

	invalidate(): void {
		this.op("invalidate");
	}

	startPainting(): void {
		this.op("startPainting");
	}

	stopPainting(): void {
		this.op("stopPainting");
	}

	focus(): void {
		this.op("focus");
	}

	setAudioMuted(muted: boolean): void {
		this.op("setAudioMuted", { muted });
	}

	openDevTools(options?: { mode?: string }): void {
		this.op("openDevTools", { ...options });
	}

	closeDevTools(): void {
		this.op("closeDevTools");
	}

	toggleDevTools(): void {
		this.op(this.#state.devtoolsOpened ? "closeDevTools" : "openDevTools");
	}

	isDevToolsOpened(): boolean {
		return this.#state.devtoolsOpened;
	}

	undo(): void {
		this.op("undo");
	}
	redo(): void {
		this.op("redo");
	}
	cut(): void {
		this.op("cut");
	}
	copy(): void {
		this.op("copy");
	}
	paste(): void {
		this.op("paste");
	}
	pasteAndMatchStyle(): void {
		this.op("pasteAndMatchStyle");
	}
	selectAll(): void {
		this.op("selectAll");
	}
	delete(): void {
		this.op("delete");
	}

	replaceMisspelling(text: string): void {
		this.op("replaceMisspelling", { text });
	}

	copyImageAt(x: number, y: number): void {
		this.op("copyImageAt", { x, y });
	}

	/** Main → page push (`window.omp` listeners). */
	send(channel: string, ...args: unknown[]): void {
		if (this.#destroyed) return;
		void this.#host.client.event("wc.send", { wcId: this.id, channel, args: encodeBin(args) });
	}

	close(): void {
		this.op("close");
	}

	// --- scripts and pictures ---

	async executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> {
		const answer = await this.opAsync<{ result: unknown }>("executeJavaScript", {
			code,
			userGesture: userGesture === true,
		});
		return answer.result;
	}

	/** `executeJavaScriptInIsolatedWorld`: a DevTools isolated world of the main frame, named by `worldId`. */
	async executeJavaScriptInIsolatedWorld(
		worldId: number,
		scripts: Array<{ code: string }>,
		userGesture?: boolean,
	): Promise<unknown> {
		const tree = (await this.cdp("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
		const world = (await this.cdp("Page.createIsolatedWorld", {
			frameId: tree.frameTree.frame.id,
			worldName: `ompdesk-world-${worldId}`,
		})) as { executionContextId: number };
		let value: unknown;
		for (const script of scripts) {
			const evaluated = (await this.cdp("Runtime.evaluate", {
				expression: script.code,
				contextId: world.executionContextId,
				awaitPromise: true,
				returnByValue: true,
				userGesture: userGesture === true,
			})) as {
				result?: { value?: unknown };
				exceptionDetails?: { text?: string; exception?: { description?: string } };
			};
			if (evaluated.exceptionDetails)
				throw new Error(
					evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "script failed",
				);
			value = evaluated.result?.value;
		}
		return value;
	}

	/**
	 * `capturePage`: the page's pixels as PNG (`Page.captureScreenshot`), of `rect` (CSS px) when given. The image
	 * remembers how to be taken again at another scale (`NativeImage#fitted`), since nothing here resizes a bitmap.
	 */
	async capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage> {
		const take = async (scale: number): Promise<Buffer> => {
			const clip = rect ?? (await this.#viewport());
			const shot = (await this.cdp("Page.captureScreenshot", {
				format: "png",
				fromSurface: true,
				...(rect || scale !== 1 ? { clip: { ...clip, scale } } : {}),
			})) as { data: string };
			return Buffer.from(shot.data, "base64");
		};
		return NativeImage.fromCapture(await take(1), ratio => take(ratio));
	}

	async #viewport(): Promise<{ x: number; y: number; width: number; height: number }> {
		const metrics = (await this.cdp("Page.getLayoutMetrics")) as {
			cssVisualViewport: { clientWidth: number; clientHeight: number };
		};
		return {
			x: 0,
			y: 0,
			width: metrics.cssVisualViewport.clientWidth,
			height: metrics.cssVisualViewport.clientHeight,
		};
	}

	async printToPDF(
		options: { printBackground?: boolean; landscape?: boolean; pageSize?: string } = {},
	): Promise<Buffer> {
		const size = options.pageSize === "A4" ? { paperWidth: 8.27, paperHeight: 11.69 } : {};
		const pdf = (await this.cdp("Page.printToPDF", {
			printBackground: options.printBackground === true,
			landscape: options.landscape === true,
			transferMode: "ReturnAsBase64",
			...size,
		})) as { data: string };
		return Buffer.from(pdf.data, "base64");
	}

	/** Browser-process input through the DevTools protocol: it reaches the page as real input does. */
	sendInputEvent(event: InputEvent): void {
		for (const command of inputCommands(event)) {
			this.cdp(command.method, command.params).catch((error: unknown) =>
				this.#host.warn(`sendInputEvent: ${String(error)}`),
			);
		}
	}

	async insertText(text: string): Promise<void> {
		await this.cdp("Input.insertText", { text });
	}

	// --- registry ---

	/** Runs the listeners of `kind` as `emitPreventable` would: true when none prevented the default. */
	notify(name: string, ...args: unknown[]): boolean {
		return emitPreventable(this, name, ...args);
	}
}

/** `webContents.getAllWebContents()` and friends, over the live pages. */
export function webContentsModule(host: Host) {
	const live = (): WebContents[] =>
		[...host.pages.values()].filter((page): page is WebContents => page instanceof WebContents);
	return {
		getAllWebContents: live,
		fromId: (id: number): WebContents | undefined => live().find(page => page.id === id),
		getFocusedWebContents: (): WebContents | null => null,
	};
}

/** The shell's requests and events about pages, routed to their `WebContents`. */
export function servePages(host: Host): void {
	const { client } = host;
	client.on("wc.state", (state: { wcId: number } & Partial<WcState>) => {
		const { wcId, ...rest } = state;
		host.pages.get(wcId)?.handleState(rest);
	});
	client.on("wc.event", ({ wcId, name, args }: { wcId: number; name: string; args?: unknown[] }) => {
		host.pages.get(wcId)?.handleEvent(name, args ?? []);
	});
	client.on("wc.paint", ({ wcId, ...paint }: { wcId: number; width: number; height: number; scale?: number }) => {
		host.pages.get(wcId)?.handleEvent("paint", [paint]);
	});
	client.on(
		"wc.cdp.message",
		({ wcId, method, params, sessionId }: { wcId: number; method: string; params: unknown; sessionId?: string }) => {
			(host.pages.get(wcId) as WebContents | undefined)?.handleCdp(method, params, sessionId);
		},
	);
	client.on("wc.cdp.detached", ({ wcId, reason }: { wcId: number; reason: string }) => {
		(host.pages.get(wcId) as WebContents | undefined)?.handleCdpDetached(reason);
	});
	client.handle("wc.windowOpen", (params: { wcId: number } & WindowOpenDetails) => {
		const page = host.pages.get(params.wcId) as WebContents | undefined;
		return page ? page.windowOpen(params) : { action: "deny" };
	});
	client.handle("wc.navigate", (params: { wcId: number; kind: string } & Record<string, unknown>) => {
		const page = host.pages.get(params.wcId) as WebContents | undefined;
		return { prevent: page ? page.navigation(params.kind, params) : true };
	});
}

export { DEFAULT_PARTITION };
