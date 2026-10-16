/**
 * Installing the page as an app. iOS allows Web Push only for a page added to the Home Screen, and a browser tab
 * there has no `PushManager` at all, so the page tells iOS users to use Share › Add to Home Screen; Android
 * (and desktop Chromium) fire `beforeinstallprompt`, which the page keeps to show its own "Install" button.
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
	/** Already running as an installed app. */
	| "installed"
	/** iOS Safari in a tab: the Share › Add to Home Screen steps. */
	| "ios-share"
	/** The browser offers an install prompt (`beforeinstallprompt` fired). */
	| "prompt"
	/** Nothing to say. */
	| "none";

export function installGuidance(env: InstallEnvironment, promptAvailable: boolean): InstallGuidance {
	if (env.standalone) return "installed";
	if (installPlatform(env) === "ios") return "ios-share";
	return promptAvailable ? "prompt" : "none";
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
			this.#notify();
		});
	}

	get available(): boolean {
		return this.#event !== null;
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
