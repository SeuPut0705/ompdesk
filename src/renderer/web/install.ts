/**
 * Installing the page as an app. iOS allows Web Push only for a page added to the Home Screen, and a browser tab
 * there has no `PushManager` at all, so the page tells iOS users to use Share › Add to Home Screen; Chromium
 * (Chrome, Edge, Samsung Internet) fires `beforeinstallprompt`, which the page keeps to show its own "Install app"
 * button; a browser that installs only from its menu (Samsung Internet before the event, Firefox on Android) gets
 * those menu steps. Everything here is a pure decision over the browser's own words, unit-tested without a browser.
 */

export type InstallPlatform = "ios" | "android" | "other";

export interface InstallEnvironment {
	userAgent: string;
	platform: string;
	maxTouchPoints: number;
	/** `matchMedia("(display-mode: standalone)")` or iOS's `navigator.standalone`. */
	standalone: boolean;
}

/** iPhone, iPod and iPad; iPadOS 13+ reports itself as a Mac, told apart by its touch screen. */
export function installPlatform(env: InstallEnvironment): InstallPlatform {
	if (/iPhone|iPad|iPod/.test(env.userAgent)) return "ios";
	if (env.platform === "MacIntel" && env.maxTouchPoints > 1) return "ios";
	if (/Android/.test(env.userAgent)) return "android";
	return "other";
}

/** What the page should offer for installing. */
export type InstallGuidance =
	/** Already running as an installed app (or just installed from this tab). */
	| "installed"
	/** The browser offers an install prompt (`beforeinstallprompt` fired): one button. */
	| "prompt"
	/** iOS (Safari or another browser) in a tab: the Share › Add to Home Screen steps. */
	| "ios-share"
	/** Samsung Internet without a prompt: its menu steps. */
	| "samsung-menu"
	/** Firefox on Android: its menu steps. */
	| "firefox-menu"
	/** Nothing to say (a desktop browser that cannot install, or Chrome that has already used or refused its prompt). */
	| "none";

export interface InstallState {
	/** `beforeinstallprompt` fired and has not been used. */
	promptAvailable: boolean;
	/** `appinstalled` fired in this tab. */
	installed?: boolean;
}

export function installGuidance(env: InstallEnvironment, state: InstallState): InstallGuidance {
	if (env.standalone || state.installed) return "installed";
	if (installPlatform(env) === "ios") return "ios-share";
	if (state.promptAvailable) return "prompt";
	if (/SamsungBrowser/.test(env.userAgent)) return "samsung-menu";
	if (installPlatform(env) === "android" && /Firefox|Fennec/.test(env.userAgent)) return "firefox-menu";
	return "none";
}

/** The guidance that has something to do: a button or steps (everything except "installed" and "none"). */
export function installOffered(guidance: InstallGuidance): boolean {
	return guidance !== "installed" && guidance !== "none";
}

/** Locale keys of the numbered steps a menu-based guidance shows; empty for the others. */
export function installStepKeys(guidance: InstallGuidance): readonly string[] {
	switch (guidance) {
		case "ios-share":
			return ["web.install.ios1", "web.install.ios2", "web.install.ios3"];
		case "samsung-menu":
			return ["web.install.samsung1", "web.install.samsung2", "web.install.samsung3"];
		case "firefox-menu":
			return ["web.install.firefox1", "web.install.firefox2", "web.install.firefox3"];
		default:
			return [];
	}
}

/** Chromium's install prompt event. */
export interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallEventTarget {
	addEventListener(type: "beforeinstallprompt" | "appinstalled", listener: (event: Event) => void): void;
}

/** Keeps the install prompt the browser offered until the user asks for it (it fires once, early). */
export class InstallPrompt {
	#event: BeforeInstallPromptEvent | null = null;
	#installed = false;
	readonly #listeners = new Set<() => void>();

	constructor(target: InstallEventTarget) {
		target.addEventListener("beforeinstallprompt", event => {
			// Chromium would show its own mini-bar; the page's button replaces it.
			event.preventDefault();
			this.#event = event as BeforeInstallPromptEvent;
			this.#notify();
		});
		target.addEventListener("appinstalled", () => {
			this.#event = null;
			this.#installed = true;
			this.#notify();
		});
	}

	get available(): boolean {
		return this.#event !== null;
	}

	/** The app was installed from this tab (`appinstalled`). */
	get installed(): boolean {
		return this.#installed;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Show the browser's install dialog. A prompt can be used once. */
	async install(): Promise<"accepted" | "dismissed" | "unavailable"> {
		const event = this.#event;
		if (!event) return "unavailable";
		this.#event = null;
		this.#notify();
		await event.prompt();
		return (await event.userChoice).outcome;
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

/** The one quiet hint after the second visit: its memory is two numbers' worth of state in `localStorage`. */
export interface InstallHintRecord {
	/** Visits counted so far (one per browser session). */
	visits: number;
	/** The hint was shown once; it never shows again on a later visit. */
	shown: boolean;
}

export const INSTALL_HINT_VISITS = 2;

/** Whether the hint shows now: an installable page, the second visit or later, and not already shown. */
export function installHintDue(record: InstallHintRecord, guidance: InstallGuidance): boolean {
	return installOffered(guidance) && record.visits >= INSTALL_HINT_VISITS && !record.shown;
}
