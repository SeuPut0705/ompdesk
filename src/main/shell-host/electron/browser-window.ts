/**
 * `BrowserWindow` over the host protocol (PROTOCOL.md §3, §5). The constructors return at
 * once as Electron's do, so the ids are Node's to assign; the shell's `win.state` pushes feed the synchronous getters
 * (`getBounds`, `isMaximized`, …), and the window's own calls update that mirror at once (`show()` then
 * `isVisible()` reads true) until the shell's push says what really happened.
 */
import { EventEmitter } from "node:events";
import type { Rect, WinState } from "../facts";
import { emitPreventable, type Host, makeEvent } from "./host";
import { DEFAULT_PARTITION, type Session } from "./session";
import { WebContents } from "./web-contents";

/** How long a quit waits for the shell to confirm its windows closed. */
const WINDOW_CLOSE_MS = 10_000;

/** The app's emitter: `browser-window-created`, `browser-window-focus`, `window-all-closed`. */
interface AppEvents {
	emit(name: string, ...args: unknown[]): boolean;
}

interface WebPreferences {
	session?: Session;
	preload?: string;
	[key: string]: unknown;
}

export interface BrowserWindowOptions {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	minWidth?: number;
	minHeight?: number;
	show?: boolean;
	useContentSize?: boolean;
	enableLargerThanScreen?: boolean;
	autoHideMenuBar?: boolean;
	icon?: string;
	backgroundColor?: string;
	transparent?: boolean;
	titleBarStyle?: string;
	trafficLightPosition?: { x: number; y: number };
	titleBarOverlay?: boolean | { color?: string; symbolColor?: string; height?: number };
	backgroundMaterial?: string;
	webPreferences?: WebPreferences;
	[key: string]: unknown;
}

/** `webPreferences` as the shell takes it: the session as its partition name, no preload (the shell injects its own). */
function shellPreferences(preferences: WebPreferences | undefined): Record<string, unknown> {
	const { session, preload: _preload, ...rest } = preferences ?? {};
	return { ...rest, session: session?.partition ?? DEFAULT_PARTITION };
}

function initialState(options: BrowserWindowOptions): WinState {
	const bounds: Rect = {
		x: options.x ?? 0,
		y: options.y ?? 0,
		width: options.width ?? 800,
		height: options.height ?? 600,
	};
	return {
		bounds,
		normalBounds: bounds,
		contentBounds: bounds,
		visible: false,
		focused: false,
		minimized: false,
		maximized: false,
		fullscreen: false,
		title: "",
		opacity: 1,
	};
}

export function createWindowClasses(host: Host, app: AppEvents, sessionFor: (partition: string) => Session) {
	const windows = new Map<number, BrowserWindow>();
	let focused: BrowserWindow | null = null;

	class BrowserWindow extends EventEmitter {
		readonly id: number;
		readonly webContents: WebContents;
		#state: WinState;
		#destroyed = false;

		constructor(options: BrowserWindowOptions = {}) {
			super();
			this.id = host.nextWindowId();
			this.#state = initialState(options);
			const preferences = shellPreferences(options.webPreferences);
			this.webContents = new WebContents(
				host,
				host.nextContentsId(),
				{ partition: String(preferences.session), windowId: this.id },
				sessionFor,
			);
			windows.set(this.id, this);
			const { webPreferences: _drop, ...rest } = options;
			host.post("win.create", {
				winId: this.id,
				wcId: this.webContents.id,
				options: { ...rest, webPreferences: preferences },
			});
			app.emit("browser-window-created", makeEvent(), this);
		}

		static getAllWindows(): BrowserWindow[] {
			return [...windows.values()];
		}

		static getFocusedWindow(): BrowserWindow | null {
			return focused && !focused.#destroyed ? focused : null;
		}

		static fromWebContents(contents: { id: number } | null | undefined): BrowserWindow | null {
			if (!contents) return null;
			for (const win of windows.values()) if (win.webContents.id === contents.id) return win;
			return null;
		}

		static fromId(id: number): BrowserWindow | null {
			return windows.get(id) ?? null;
		}

		#op(op: string, args: Record<string, unknown> = {}): void {
			if (!this.#destroyed) host.post("win.op", { winId: this.id, op, args });
		}

		/**
		 * The mirror after a call that moves or resizes the window, as Electron answers at once: the outer rect is
		 * what was asked, and the content rect keeps the frame's insets the shell last reported.
		 */
		#resized(bounds: Rect): void {
			const old = this.#state;
			const left = old.contentBounds.x - old.bounds.x;
			const top = old.contentBounds.y - old.bounds.y;
			const horizontal = old.bounds.width - old.contentBounds.width;
			const vertical = old.bounds.height - old.contentBounds.height;
			this.#state = {
				...old,
				bounds,
				contentBounds: {
					x: bounds.x + left,
					y: bounds.y + top,
					width: Math.max(0, bounds.width - horizontal),
					height: Math.max(0, bounds.height - vertical),
				},
			};
		}

		/** `win.state`: the shell's account of the window. */
		applyState(state: Partial<WinState>): void {
			this.#state = { ...this.#state, ...state };
		}

		/** `win.event`: a window event; `closed` ends the window. */
		applyEvent(name: string, args: unknown[]): void {
			if (name === "closed") {
				this.#finalize();
				return;
			}
			if (name === "focus") {
				focused = this;
				this.#state = { ...this.#state, focused: true };
				app.emit("browser-window-focus", makeEvent(), this);
			} else if (name === "blur") {
				if (focused === this) focused = null;
				this.#state = { ...this.#state, focused: false };
				app.emit("browser-window-blur", makeEvent(), this);
			}
			this.emit(name, makeEvent(), ...args);
		}

		/** `win.closeRequested`: true when a `close` listener prevented the close. */
		closeRequested(): boolean {
			return !emitPreventable(this, "close");
		}

		#finalize(): void {
			if (this.#destroyed) return;
			this.#destroyed = true;
			windows.delete(this.id);
			if (focused === this) focused = null;
			this.emit("closed");
			if (windows.size === 0) app.emit("window-all-closed");
		}

		isDestroyed(): boolean {
			return this.#destroyed;
		}

		close(): void {
			this.tryClose();
		}

		/** `close()` that says whether the window is going: false when a `close` listener kept it open. */
		tryClose(): boolean {
			if (this.#destroyed) return true;
			if (!emitPreventable(this, "close")) return false;
			this.#op("close", { force: true });
			return true;
		}

		destroy(): void {
			if (this.#destroyed) return;
			this.#op("destroy");
			this.#finalize();
		}

		show(): void {
			this.#state = { ...this.#state, visible: true, minimized: false };
			this.#op("show");
		}

		showInactive(): void {
			this.#state = { ...this.#state, visible: true, minimized: false };
			this.#op("showInactive");
		}

		hide(): void {
			this.#state = { ...this.#state, visible: false };
			this.#op("hide");
		}

		focus(): void {
			this.#op("focus");
		}

		blur(): void {
			this.#op("blur");
		}

		minimize(): void {
			this.#state = { ...this.#state, minimized: true };
			this.#op("minimize");
		}

		maximize(): void {
			this.#state = { ...this.#state, maximized: true, visible: true };
			this.#op("maximize");
		}

		unmaximize(): void {
			this.#state = { ...this.#state, maximized: false };
			this.#op("unmaximize");
		}

		restore(): void {
			this.#state = { ...this.#state, minimized: false, maximized: false };
			this.#op("restore");
		}

		setFullScreen(on: boolean): void {
			this.#state = { ...this.#state, fullscreen: on };
			this.#op("setFullScreen", { on });
		}

		isVisible(): boolean {
			return this.#state.visible && !this.#state.minimized;
		}

		isFocused(): boolean {
			return this.#state.focused;
		}

		isMinimized(): boolean {
			return this.#state.minimized;
		}

		isMaximized(): boolean {
			return this.#state.maximized;
		}

		isFullScreen(): boolean {
			return this.#state.fullscreen;
		}

		isNormal(): boolean {
			return !this.#state.minimized && !this.#state.maximized && !this.#state.fullscreen;
		}

		getBounds(): Rect {
			return { ...this.#state.bounds };
		}

		getNormalBounds(): Rect {
			return { ...this.#state.normalBounds };
		}

		getContentBounds(): Rect {
			return { ...this.#state.contentBounds };
		}

		getSize(): [number, number] {
			return [this.#state.bounds.width, this.#state.bounds.height];
		}

		getContentSize(): [number, number] {
			return [this.#state.contentBounds.width, this.#state.contentBounds.height];
		}

		getPosition(): [number, number] {
			return [this.#state.bounds.x, this.#state.bounds.y];
		}

		getTitle(): string {
			return this.#state.title;
		}

		getOpacity(): number {
			return this.#state.opacity;
		}

		setBounds(bounds: Partial<Rect>): void {
			this.#resized({ ...this.#state.bounds, ...bounds });
			this.#op("setBounds", { bounds: this.#state.bounds });
		}

		setSize(width: number, height: number): void {
			this.#resized({ ...this.#state.bounds, width, height });
			this.#op("setSize", { width, height });
		}

		setContentSize(width: number, height: number): void {
			const old = this.#state;
			this.#resized({
				...old.bounds,
				width: width + (old.bounds.width - old.contentBounds.width),
				height: height + (old.bounds.height - old.contentBounds.height),
			});
			this.#op("setContentSize", { width, height });
		}

		setPosition(x: number, y: number): void {
			this.#resized({ ...this.#state.bounds, x, y });
			this.#op("setPosition", { x, y });
		}

		center(): void {
			this.#op("center");
		}

		setMinimumSize(width: number, height: number): void {
			this.#op("setMinimumSize", { width, height });
		}

		setMaximumSize(width: number, height: number): void {
			this.#op("setMaximumSize", { width, height });
		}

		setOpacity(value: number): void {
			this.#state = { ...this.#state, opacity: value };
			this.#op("setOpacity", { value });
		}

		setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
			this.#op("setIgnoreMouseEvents", {
				ignore,
				...(options?.forward === undefined ? {} : { forward: options.forward }),
			});
		}

		setSkipTaskbar(skip: boolean): void {
			this.#op("setSkipTaskbar", { skip });
		}

		setFocusable(focusable: boolean): void {
			this.#op("setFocusable", { focusable });
		}

		setProgressBar(value: number, options?: { mode?: string }): void {
			this.#op("setProgressBar", { value, ...(options?.mode === undefined ? {} : { mode: options.mode }) });
		}

		setTitleBarOverlay(options: { color?: string; symbolColor?: string; height?: number }): void {
			this.#op("setTitleBarOverlay", { ...options });
		}

		setTitle(title: string): void {
			this.#state = { ...this.#state, title };
			this.#op("setTitle", { title });
		}

		setBackgroundColor(color: string): void {
			this.#op("setBackgroundColor", { color });
		}

		setBackgroundMaterial(material: string): void {
			this.#op("setBackgroundMaterial", { material });
		}

		setAlwaysOnTop(flag: boolean): void {
			this.#op("setAlwaysOnTop", { flag });
		}

		setMenuBarVisibility(visible: boolean): void {
			this.#op("setMenuBarVisibility", { visible });
		}

		setAutoHideMenuBar(hide: boolean): void {
			this.#op("setAutoHideMenuBar", { hide });
		}

		setIcon(path: string): void {
			this.#op("setIcon", { path });
		}

		/** `win.capturePage`: the window's page, as `webContents.capturePage` (the frame is not part of it). */
		capturePage(rect?: Rect): ReturnType<WebContents["capturePage"]> {
			return this.webContents.capturePage(rect);
		}

		loadURL(
			url: string,
			options?: { userAgent?: string; httpReferrer?: string; extraHeaders?: string },
		): Promise<void> {
			return this.webContents.loadURL(url, options);
		}

		loadFile(filePath: string, options?: { query?: Record<string, string>; hash?: string }): Promise<void> {
			return this.webContents.loadFile(filePath, options);
		}
	}

	host.client.on("win.state", ({ winId, ...state }: { winId: number } & Partial<WinState>) => {
		windows.get(winId)?.applyState(state);
	});
	host.client.on("win.event", ({ winId, name, args }: { winId: number; name: string; args?: unknown[] }) => {
		windows.get(winId)?.applyEvent(name, args ?? []);
	});
	host.client.handle("win.closeRequested", ({ winId }: { winId: number }) => ({
		prevent: windows.get(winId)?.closeRequested() ?? false,
	}));

	/** What a quit does to the windows: each is closed through its `close` listeners; false when one stayed open. */
	async function closeAll(): Promise<boolean> {
		const open = [...windows.values()];
		const gone = open.map(win => new Promise<void>(resolve => win.once("closed", () => resolve())));
		let kept = false;
		for (const win of open) if (!win.tryClose()) kept = true;
		if (kept) return false;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>(resolve => {
			timer = setTimeout(resolve, WINDOW_CLOSE_MS);
			timer.unref();
		});
		await Promise.race([Promise.all(gone), timeout]);
		clearTimeout(timer);
		return windows.size === 0;
	}

	return { BrowserWindow, closeAll };
}
