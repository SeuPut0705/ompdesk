/**
 * The web page's installed-app services in one place for the UI that is not `window.omp` (the notification
 * controls in Settings, the install guidance): push, the install prompt and the update watcher. `web-boot.ts`
 * builds it from the real browser objects and sets it; a desktop window never does, so `webPwa()` is how a
 * component knows it runs on the web page.
 */
import type { WebFeatures } from "../../shared/web-protocol";
import {
	type InstallEnvironment,
	type InstallEventTarget,
	type InstallGuidance,
	InstallPrompt,
	installGuidance,
	installPlatform,
} from "./install";
import { PushClient, type PushEnv, type PushManagerLike, type PushPermission } from "./push-client";
import type { UpdateWatcher } from "./sw-update";

export interface WebPwa {
	push: PushClient;
	install: InstallPrompt;
	/** Where the page runs (iOS or not, installed or in a tab). */
	environment(): InstallEnvironment;
	/** What to offer for installing right now. */
	guidance(): InstallGuidance;
	/** The update watcher once the service worker is registered; null without one. */
	update: UpdateWatcher | null;
}

let pwa: WebPwa | null = null;

export function setWebPwa(next: WebPwa): void {
	pwa = next;
}

/** The page's PWA services; null in the desktop app. */
export function webPwa(): WebPwa | null {
	return pwa;
}

/** Where this browser runs, from the real globals. */
export function browserInstallEnvironment(): InstallEnvironment {
	const iosStandalone = "standalone" in navigator && navigator.standalone === true;
	return {
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		maxTouchPoints: navigator.maxTouchPoints,
		standalone: window.matchMedia("(display-mode: standalone)").matches || iosStandalone,
	};
}

export interface BrowserPwaDeps {
	/** The page's registration of `/sw.js` (null when none: insecure page, no support, no worker). */
	registration: Promise<ServiceWorkerRegistration | null>;
	features: () => WebFeatures | null;
	update: UpdateWatcher | null;
}

export function createBrowserPwa(deps: BrowserPwaDeps): WebPwa {
	const environment = browserInstallEnvironment;
	const install = new InstallPrompt(window as unknown as InstallEventTarget);
	const iosTab = () => {
		const env = environment();
		return !env.standalone && installPlatform(env) === "ios";
	};
	const pushEnv: PushEnv = {
		fetch: (input, init) => fetch(input, init),
		isSecureContext: window.isSecureContext,
		get needsInstall() {
			return iosTab();
		},
		get supported() {
			return "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
		},
		hostPush: () => deps.features()?.push ?? null,
		permission: (): PushPermission => ("Notification" in window ? Notification.permission : "unsupported"),
		requestPermission: async (): Promise<PushPermission> =>
			"Notification" in window ? await Notification.requestPermission() : "unsupported",
		pushManager: async (): Promise<PushManagerLike | null> => {
			if (!(await deps.registration)) return null;
			// `subscribe` needs an active worker; `ready` resolves once the registration has one.
			return (await navigator.serviceWorker.ready).pushManager;
		},
	};
	return {
		push: new PushClient(pushEnv),
		install,
		environment,
		guidance: () => installGuidance(environment(), install.available),
		update: deps.update,
	};
}
