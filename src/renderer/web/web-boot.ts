/**
 * Entry of `web.html`, the page a paired phone or tablet loads. It installs `window.omp` over the socket
 * transport and then loads the same renderer entry the desktop window runs (`../main`), so the app does not
 * know which one it is in. `/pair` runs the pairing screen instead and never loads the app.
 *
 * The app, the stores and the pairing screen are imported dynamically on purpose: a module that reads
 * `window.omp` while it evaluates would run before this file has installed it, and the pairing screen must
 * not pull the app in.
 */
import { IPC_EVENTS } from "../../shared/ipc-types";
import { translate } from "../lib/i18n";
import { WebChrome } from "./chrome";
import { mountConnectionBanner } from "./connection-banner";
import { LocalChannels, parseOpenHash } from "./deep-link";
import { saveBlob } from "./download";
import { mountNotificationSweep } from "./notification-sweep";
import { listenNotificationClicks, notifyPage, registerServiceWorker, requestNotificationPermission } from "./notify";
import { createBrowserPwa, setWebPwa } from "./pwa";
import { setWebRuntime } from "./runtime";
import { fetchTicket } from "./session";
import { createWebOmp } from "./shim";
import { purgeAndReload, type SafeMoment, safeToReload, UpdateWatcher } from "./sw-update";
import { pickFiles } from "./upload";
import { type WsLike, WsTransport } from "./ws-transport";

/** Marks a reload the page made to pick up a newer bundle; a second one within the window shows the notice instead. */
const RELOAD_FLAG = "omp.web.reloaded-at";
const RELOAD_LOOP_MS = 30_000;

async function pageStale(): Promise<void> {
	// A cached older bundle against a newer host: drop the service worker's caches and reload once.
	const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
	if (Date.now() - last < RELOAD_LOOP_MS) return;
	sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
	await purgeAndReload(navigator.serviceWorker, typeof caches === "undefined" ? undefined : caches, () =>
		location.reload(),
	);
}

async function bootApp(): Promise<void> {
	const channels = new LocalChannels();
	const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
	const resyncHandlers: (() => void)[] = [];
	const transport = new WsTransport({
		url: wsUrl,
		fetchTicket: () => fetchTicket({ fetch: (input, init) => fetch(input, init) }),
		// The browser's WebSocket has the members WsLike names; its event handler types are only narrower.
		createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike,
		isVisible: () => document.visibilityState === "visible",
		onOutdated: () => void pageStale(),
		// Events were missed while the link was down: the default is to load the page again (its start-up
		// restores tabs and open asks from the host); a sheet that can refresh in place registers a handler.
		onResync: () => {
			const handler = resyncHandlers.at(-1);
			if (handler) handler();
			else location.reload();
		},
		onUnpaired: () => location.replace("/pair"),
	});

	const registration = registerServiceWorker();
	const openTarget = parseOpenHash(location.hash);
	let pendingSessionPath = openTarget?.kind === "session-path" ? openTarget.sessionPath : null;

	const web = createWebOmp({
		transport,
		fetch: (input, init) => fetch(input, init),
		chrome: new WebChrome({ document, navigator }),
		channels,
		t: translate,
		browser: {
			open: url => void window.open(url, "_blank", "noopener,noreferrer"),
			confirm: message => window.confirm(message),
			prompt: (message, initial) => window.prompt(message, initial),
		},
		openTab: async payload => {
			const { useTabsStore } = await import("../stores/tabs");
			return useTabsStore.getState().openTab(payload);
		},
		takePendingSessionPath: () => {
			const taken = pendingSessionPath;
			pendingSessionPath = null;
			return taken;
		},
		notify: (title, body, tabId, kind) => {
			void notifyPage(
				{
					isVisible: () => document.visibilityState === "visible",
					permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
					registration: () => registration,
					toast: (toastTitle, toastBody, onOpen) => {
						void import("../stores/toast").then(({ useToastStore }) =>
							useToastStore.getState().push({
								variant: "info",
								title: toastBody ? toastTitle : undefined,
								message: toastBody ?? toastTitle,
								action: onOpen ? { label: translate("web.notify.open"), run: onOpen } : undefined,
							}),
						);
					},
					openTab: tabId => channels.emit(IPC_EVENTS.NOTIFICATION_CLICK, { tabId }),
				},
				title,
				body,
				tabId,
				kind,
			);
		},
		save: saveBlob,
		pickFiles: accept => pickFiles(accept),
		toastError: message => {
			void import("../stores/toast").then(({ useToastStore }) =>
				useToastStore.getState().push({ variant: "error", message }),
			);
		},
	});

	window.omp = web.api;
	setWebRuntime({
		host: web.host,
		connectionState: () => transport.state,
		onConnectionState: listener => transport.onState(listener),
		features: () => transport.features,
		emitMenuAction: web.emitMenuAction,
		setResyncHandler: handler => {
			resyncHandlers.push(handler);
			return () => {
				const index = resyncHandlers.lastIndexOf(handler);
				if (index >= 0) resyncHandlers.splice(index, 1);
			};
		},
		requestNotifications: requestNotificationPermission,
	});

	listenNotificationClicks(payload => channels.emit(IPC_EVENTS.NOTIFICATION_CLICK, payload));
	mountConnectionBanner(transport, document, translate);
	const purge = () =>
		void purgeAndReload(navigator.serviceWorker, typeof caches === "undefined" ? undefined : caches, () =>
			location.reload(),
		);

	// Push, install guidance and the update watcher, for the notification controls in Settings.
	const pwa = createBrowserPwa({ registration, features: () => transport.features, update: null });
	setWebPwa(pwa);

	// Updates apply by themselves (sw-update.ts): at launch and whenever the page comes back to the foreground,
	// when the composer is empty, nothing waits for an answer and no upload is on its way. `moment` exists once
	// the app (and its stores) has loaded; until then nothing is safe.
	let moment: SafeMoment | null = null;
	let resumedAt = 0;
	const RESUME_WINDOW_MS = 15_000;
	const applyUpdate = () => {
		if (!moment) return;
		if (pwa.update) pwa.update.resume(moment);
		else if (transport.state === "outdated" && safeToReload(moment)) purge();
	};
	void registration.then(registered => {
		if (!registered) return;
		const watcher = new UpdateWatcher(registered, navigator.serviceWorker, () => location.reload(), purge);
		if (transport.state === "outdated") watcher.markOutdated();
		pwa.update = watcher;
		// A build that finishes installing just after the page came back is applied then, not a visit later.
		watcher.onChange(() => {
			if (Date.now() - resumedAt < RESUME_WINDOW_MS) applyUpdate();
		});
		applyUpdate();
	});
	transport.onState(state => {
		if (state !== "outdated") return;
		pwa.update?.markOutdated();
		applyUpdate();
	});

	document.addEventListener("visibilitychange", () => {
		const visible = document.visibilityState === "visible";
		transport.setPresence(visible);
		if (visible) {
			resumedAt = Date.now();
			transport.wake();
			applyUpdate();
			void pwa.update?.check().then(applyUpdate);
		}
	});
	window.addEventListener("online", () => transport.wake());
	window.addEventListener("pageshow", () => transport.wake());

	// A link or notification click the page was opened at (queued until the app listens), and later ones.
	const route = (hash: string) => {
		const target = parseOpenHash(hash);
		if (target?.kind === "deep-link") channels.emit(IPC_EVENTS.DEEP_LINK, target.link);
		else if (target?.kind === "notification-click") channels.emit(IPC_EVENTS.NOTIFICATION_CLICK, target.payload);
	};
	route(location.hash);
	window.addEventListener("hashchange", () => route(location.hash));

	transport.start();
	await import("../main");
	const [{ useComposerStore }, { useExtensionUiStore }, { usePlanApprovalStore }, { uploadsInFlight }] =
		await Promise.all([
			import("../stores/composer"),
			import("../stores/extension-ui"),
			import("../stores/plan-approval"),
			import("./upload"),
		]);
	moment = {
		visible: () => document.visibilityState === "visible",
		draftEmpty: () => {
			const composer = useComposerStore.getState();
			return composer.draft.trim() === "" && composer.images.length === 0;
		},
		askOpen: () =>
			useExtensionUiStore.getState().pendingRequests.length > 0 || usePlanApprovalStore.getState().pending !== null,
		uploading: () => uploadsInFlight() > 0,
	};
	resumedAt = Date.now();
	applyUpdate();
	// The host never pushes to a visible device, so banners left from when the page was hidden are closed here.
	const { useTabsStore } = await import("../stores/tabs");
	mountNotificationSweep({
		registration,
		isVisible: () => document.visibilityState === "visible",
		onVisibilityChange: listener => document.addEventListener("visibilitychange", listener),
		onActiveTab: listener =>
			useTabsStore.subscribe((next, previous) => {
				if (next.activeTabId && next.activeTabId !== previous.activeTabId) listener(next.activeTabId);
			}),
	});
}

async function boot(): Promise<void> {
	document.documentElement.dataset.platform = "web";
	if (location.pathname === "/pair") {
		const { renderPairScreen } = await import("./pair-boot");
		renderPairScreen();
		return;
	}
	await bootApp();
}

void boot();
