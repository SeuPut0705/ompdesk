/**
 * The small desktop modules of `electron`: `dialog`, `clipboard`, `shell`, `Notification`, `screen`, `nativeTheme`,
 * `powerMonitor`, `systemPreferences` and the native `autoUpdater` (PROTOCOL.md §8, §9). Their synchronous getters
 * answer from what the shell hands over and pushes (`facts`, `screen.changed`, `theme.changed`); the few that cannot
 * (`clipboard.readText`, `powerMonitor.getSystemIdleTime`, the macOS permission queries) throw and have an `…Async`
 * form that asks. The app's theme source, keep-awake's blockers and the global shortcut are `boot.*`'s (§15.9).
 */
import { EventEmitter } from "node:events";
import type { DisplayFact, Rect } from "../facts";
import { type Host, makeEvent } from "./host";

function unavailable(what: string, instead: string): never {
	throw new Error(`${what} is synchronous in Electron and cannot be answered by the shell: use ${instead}`);
}

interface MessageBoxResult {
	response: number;
	checkboxChecked: boolean;
}

export function createDesktopModules(host: Host, deps: { focusedWindowId(): number | undefined }) {
	const { client, facts } = host;

	// --- dialog ---
	type Owner = { id: number } | null | undefined;
	const splitOwner = <T>(first: Owner | T, second?: T): { winId?: number; options: T } => {
		if (second !== undefined) return { winId: (first as { id: number } | null)?.id, options: second };
		return { options: first as T };
	};
	const dialog = {
		/**
		 * `options.signal` closes the box as if the person backed out: the shell cancels it and still answers, with its
		 * `cancelId`, which is what this resolves to (Electron's semantics).
		 */
		async showMessageBox(
			first: Owner | Record<string, unknown>,
			second?: Record<string, unknown>,
		): Promise<MessageBoxResult> {
			const { winId, options } = splitOwner(first, second);
			const { signal, ...rest } = options;
			return client.call<MessageBoxResult>(
				"dialog.messageBox",
				{ winId, options: rest },
				signal instanceof AbortSignal ? { signal, answerAfterCancel: true } : {},
			);
		},
		async showOpenDialog(
			first: Owner | Record<string, unknown>,
			second?: Record<string, unknown>,
		): Promise<{ canceled: boolean; filePaths: string[] }> {
			return client.call("dialog.openDialog", splitOwner(first, second));
		},
		async showSaveDialog(
			first: Owner | Record<string, unknown>,
			second?: Record<string, unknown>,
		): Promise<{ canceled: boolean; filePath?: string }> {
			return client.call("dialog.saveDialog", splitOwner(first, second));
		},
		showErrorBox(title: string, content: string): void {
			host.post("dialog.messageBox", {
				options: { type: "error", title, message: title, detail: content, buttons: ["OK"] },
			});
		},
	};

	// --- clipboard ---
	const clipboard = {
		readText(): string {
			return unavailable("clipboard.readText()", "clipboard.readTextAsync()");
		},
		async readTextAsync(): Promise<string> {
			return (await client.call<{ text: string }>("clipboard.readText")).text;
		},
		writeText(text: string): void {
			host.post("clipboard.writeText", { text });
		},
	};

	// --- shell ---
	const shell = {
		async openExternal(url: string): Promise<void> {
			await client.call("shell.openExternal", { url });
		},
		async openPath(path: string): Promise<string> {
			return (await client.call<{ error: string }>("shell.openPath", { path })).error;
		},
		showItemInFolder(path: string): void {
			host.post("shell.showItemInFolder", { path });
		},
		async trashItem(path: string): Promise<void> {
			await client.call("shell.trashItem", { path });
		},
		beep(): void {
			host.post("shell.beep");
		},
	};

	// --- Notification ---
	const notifications = new Map<number, NotificationImpl>();
	let nextNotification = 1;
	class NotificationImpl extends EventEmitter {
		readonly #id = nextNotification++;
		readonly #options: Record<string, unknown>;
		title: string;
		body: string;

		constructor(options: { title?: string; body?: string; [key: string]: unknown } = {}) {
			super();
			this.#options = options;
			this.title = options.title ?? "";
			this.body = options.body ?? "";
		}

		static isSupported(): boolean {
			return true;
		}

		show(): void {
			notifications.set(this.#id, this);
			host.post("notification.show", { ...this.#options, id: this.#id, title: this.title, body: this.body });
		}

		/**
		 * Takes the toast down. The entry stays until the `close` event, which Electron emits for this too (a holder
		 * such as main's `liveNotifications` releases on it): the shell's when it sends one (Windows' dismissal),
		 * else this one once the shell has answered (macOS removes a notification silently).
		 */
		close(): void {
			const id = this.#id;
			const settle = (): void => settleNotification(id, "close");
			client.call("notification.close", { id }).then(settle, (error: unknown) => {
				host.warn(`notification.close: ${error instanceof Error ? error.message : String(error)}`);
				settle();
			});
		}
	}
	function settleNotification(id: number, name: string, reason?: string): void {
		const notification = notifications.get(id);
		if (!notification) return;
		if (name === "close" || name === "failed") notifications.delete(id);
		notification.emit(name, makeEvent(), reason);
	}
	client.on("notification.event", ({ id, name, reason }: { id: number; name: string; reason?: string }) =>
		settleNotification(id, name, reason),
	);

	// --- screen ---
	let displays = facts.displays;
	let primaryId = facts.primaryDisplayId;
	const toDisplay = (fact: DisplayFact) => ({
		id: fact.id,
		label: fact.label,
		bounds: fact.bounds,
		workArea: fact.workArea,
		size: { width: fact.bounds.width, height: fact.bounds.height },
		workAreaSize: { width: fact.workArea.width, height: fact.workArea.height },
		scaleFactor: fact.scaleFactor,
		rotation: fact.rotation,
		internal: fact.internal,
		colorDepth: fact.colorDepth,
		depthPerComponent: 8,
		displayFrequency: fact.monitorFrequency ?? 60,
		monochrome: false,
		accelerometerSupport: "unknown",
		touchSupport: "unknown",
		colorSpace: "",
	});
	const area = (a: Rect, b: Rect): number => {
		const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
		const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
		return width > 0 && height > 0 ? width * height : 0;
	};
	class ScreenImpl extends EventEmitter {
		getPrimaryDisplay() {
			const primary = displays.find(display => display.id === primaryId) ?? displays[0];
			return toDisplay(primary);
		}
		getAllDisplays() {
			return displays.map(toDisplay);
		}
		getDisplayMatching(rect: Rect) {
			const best = displays.reduce((a, b) => (area(rect, b.bounds) > area(rect, a.bounds) ? b : a), displays[0]);
			return toDisplay(best);
		}
		getDisplayNearestPoint(point: { x: number; y: number }) {
			const distance = (display: DisplayFact): number => {
				const { bounds } = display;
				const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
				const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
				return dx * dx + dy * dy;
			};
			return toDisplay(displays.reduce((a, b) => (distance(b) < distance(a) ? b : a), displays[0]));
		}
	}
	const screen = new ScreenImpl();
	client.on("screen.changed", (data: { displays: DisplayFact[]; primaryDisplayId: number; reason?: string }) => {
		const previous = displays;
		displays = data.displays;
		primaryId = data.primaryDisplayId;
		for (const added of displays.filter(display => !previous.some(old => old.id === display.id)))
			screen.emit("display-added", makeEvent(), toDisplay(added));
		for (const removed of previous.filter(old => !displays.some(display => display.id === old.id)))
			screen.emit("display-removed", makeEvent(), toDisplay(removed));
		screen.emit("display-metrics-changed", makeEvent(), screen.getPrimaryDisplay(), ["bounds", "workArea"]);
	});

	// --- nativeTheme and systemPreferences ---
	let theme = { ...facts.theme };
	let reducedMotion = facts.system.reducedMotion;
	class NativeThemeImpl extends EventEmitter {
		get shouldUseDarkColors(): boolean {
			return theme.dark;
		}
		get shouldUseHighContrastColors(): boolean {
			return theme.highContrast;
		}
		get shouldUseInvertedColorScheme(): boolean {
			return theme.inverted;
		}
		#apply(next: { dark: boolean; highContrast: boolean; inverted: boolean }): void {
			const changed = next.dark !== theme.dark || next.highContrast !== theme.highContrast;
			theme = { ...next };
			if (changed) this.emit("updated");
		}
		apply(next: { dark: boolean; highContrast: boolean; inverted: boolean }): void {
			this.#apply(next);
		}
	}
	const nativeTheme = new NativeThemeImpl();
	client.on(
		"theme.changed",
		(data: { dark: boolean; highContrast: boolean; inverted: boolean; reducedMotion?: boolean }) => {
			if (data.reducedMotion !== undefined) reducedMotion = data.reducedMotion;
			nativeTheme.apply(data);
		},
	);
	const systemPreferences = {
		getAnimationSettings: () => ({
			shouldRenderRichAnimation: !reducedMotion,
			scrollAnimationsEnabledBySystem: !reducedMotion,
			prefersReducedMotion: reducedMotion,
		}),
		isTrustedAccessibilityClient(_prompt: boolean): boolean {
			return unavailable("systemPreferences.isTrustedAccessibilityClient()", "isTrustedAccessibilityClientAsync()");
		},
		getMediaAccessStatus(_mediaType: string): string {
			return unavailable("systemPreferences.getMediaAccessStatus()", "getMediaAccessStatusAsync()");
		},
		async isTrustedAccessibilityClientAsync(prompt: boolean): Promise<boolean> {
			return (await client.call<{ trusted: boolean }>("system.accessibilityTrusted", { prompt })).trusted;
		},
		async getMediaAccessStatusAsync(mediaType: string): Promise<string> {
			return (await client.call<{ status: string }>("system.mediaAccessStatus", { mediaType })).status;
		},
	};

	// --- power ---
	class PowerMonitorImpl extends EventEmitter {
		getSystemIdleTime(): number {
			return unavailable("powerMonitor.getSystemIdleTime()", "powerMonitor.getSystemIdleTimeAsync()");
		}
		async getSystemIdleTimeAsync(): Promise<number> {
			return (await client.call<{ seconds: number }>("power.idleTime")).seconds;
		}
	}
	const powerMonitor = new PowerMonitorImpl();
	client.on("power.event", ({ name }: { name: string }) => powerMonitor.emit(name, makeEvent()));

	// --- native autoUpdater (Squirrel): not in the shell; an emitter for `before-quit-for-update` only ---
	class NativeAutoUpdater extends EventEmitter {
		setFeedURL(): void {
			throw new Error("The native auto updater is not available under the shell");
		}
		checkForUpdates(): void {
			throw new Error("The native auto updater is not available under the shell");
		}
		quitAndInstall(): void {
			throw new Error("The native auto updater is not available under the shell");
		}
		getFeedURL(): string {
			return "";
		}
	}

	return {
		dialog,
		clipboard,
		shell,
		Notification: NotificationImpl,
		screen,
		nativeTheme,
		systemPreferences,
		powerMonitor,
		autoUpdater: new NativeAutoUpdater(),
		/** The window a dialog sheet or a menu belongs to when none is given. */
		focusedWindowId: deps.focusedWindowId,
	};
}
