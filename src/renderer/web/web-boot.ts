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
import { getCurrentLanguage, loadLocale, translate } from "../lib/i18n";
import { snapshots } from "../lib/snapshot-cache";
import { WebChrome } from "./chrome";
import { mountConnectionBanner } from "./connection-banner";
import { LocalChannels, parseOpenHash } from "./deep-link";
import { saveBlob } from "./download";
import { recordVisit, showInstallHintIfDue } from "./install-hint";
import { startInstall } from "./install-ui";
import { mountNotificationSweep } from "./notification-sweep";
import { listenNotificationClicks, notifyPage, registerServiceWorker, requestNotificationPermission } from "./notify";
import { createBrowserPwa, setWebPwa } from "./pwa";
import { flushReloadReasons, noteReload, type ReloadReason } from "./reload-reason";
import { PageResync } from "./resync";
import { setWebRuntime } from "./runtime";
import { fetchTicket } from "./session";
import { createWebOmp } from "./shim";
import {
	appGoneMoment,
	purgeAndReload,
	ResumeGate,
	reloadWhenUnused,
	type SafeMoment,
	safeToReload,
	UpdateWatcher,
} from "./sw-update";
import { pickFiles } from "./upload";
import { type ResyncCause, type WsLike, WsTransport } from "./ws-transport";

/** Marks a reload the page made to pick up a newer bundle; a second one within the window shows the notice instead. */
const RELOAD_FLAG = "omp.web.reloaded-at";
const RELOAD_LOOP_MS = 30_000;
/** The install hint waits for the browser's prompt, and stays up long enough to read and act on. */
const INSTALL_HINT_DELAY_MS = 6000;
const INSTALL_HINT_MS = 15_000;

/** The reason of the reload in progress, kept in `localStorage` for the next connect (reload-reason.ts). */
function noteReason(reason: ReloadReason, details?: Record<string, string | number | boolean | null>): void {
	noteReload(localStorage, { reason, at: Date.now(), ...(details ? { details } : {}) });
}

function purge(safe: () => boolean): Promise<boolean> {
	return purgeAndReload(
		navigator.serviceWorker,
		typeof caches === "undefined" ? undefined : caches,
		() => location.reload(),
		safe,
	);
}

async function pageStale(): Promise<void> {
	// A cached older bundle against a newer host, before the app loaded (nothing to lose yet): drop the service
	// worker's caches and reload once.
	const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
	if (Date.now() - last < RELOAD_LOOP_MS) return;
	sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
	noteReason("outdated", { atBoot: true });
	await purge(() => true);
}

async function bootApp(): Promise<void> {
	const channels = new LocalChannels();
	const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
	const resyncListeners = new Set<() => void>();
	// Set once the app (and its stores) has loaded; see the update rules below.
	let moment: SafeMoment | null = null;
	// When the page is not in use (launch, a return after ≥ 30 s away, until the first touch or key): sw-update.ts.
	const gate = new ResumeGate();
	// The in-place resync (resync.ts), from the app's load on; a reconnect before that only marks it wanted.
	let resync: PageResync | null = null;
	let resyncCause: ResyncCause | null = null;
	let lastResort: { recheck(): void } | null = null;
	// A chunk of this build failed to load for good (lib/chunk-load.ts): the page is outdated for the update gate.
	let chunkStale = false;
	const transport = new WsTransport({
		url: wsUrl,
		fetchTicket: () => fetchTicket({ fetch: (input, init) => fetch(input, init) }),
		// The browser's WebSocket has the members WsLike names; its event handler types are only narrower.
		createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike,
		isVisible: () => document.visibilityState === "visible",
		// Before the app loaded nothing can be lost: reload at once. After, `applyUpdate` waits for a safe moment.
		onOutdated: () => {
			if (!moment) void pageStale();
		},
		// Events were missed while the link was down (or the host restarted): the page reads its state again in
		// place (resync-page.ts), never a reload while the person reads, scrolls, types or picks files.
		onResync: cause => {
			resyncCause = cause;
			resync?.request();
		},
		onUnpaired: () => {
			// This device is no longer allowed to see this computer's sessions: nothing of them stays in the page.
			snapshots().clearAll();
			location.replace("/pair");
		},
	});

	// The worker's install fetches the shell's chunks. Registered once the app has loaded, it takes them from the
	// HTTP cache the page just filled, instead of downloading them a second time beside the page's own loads.
	const appLoaded = Promise.withResolvers<void>();
	const registration = appLoaded.promise.then(() => registerServiceWorker());
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

	// Every reload of this page says why (reload-reason.ts). A reload asked for with a reason goes through a waiting
	// new build when there is one, and the worker's `controllerchange` reload then carries that reason.
	let reloadFor: ReloadReason | null = null;
	const reloadNow = (fallback: ReloadReason, details?: Record<string, string | number | boolean | null>) => {
		noteReason(reloadFor ?? fallback, details);
		location.reload();
	};
	const purgeNow = (): Promise<boolean> => {
		noteReason(chunkStale && transport.state !== "outdated" ? "chunk-load-failed" : "outdated");
		return purge(() => !moment || safeToReload(moment));
	};

	window.omp = web.api;
	setWebRuntime({
		host: web.host,
		connectionState: () => transport.state,
		onConnectionState: listener => transport.onState(listener),
		features: () => transport.features,
		emitMenuAction: web.emitMenuAction,
		onResynced: listener => {
			resyncListeners.add(listener);
			return () => {
				resyncListeners.delete(listener);
			};
		},
		reload: reason => {
			reloadFor = reason;
			const update = pwa.update;
			if (update?.available) update.apply();
			else reloadNow(reason);
		},
		requestNotifications: requestNotificationPermission,
	});

	listenNotificationClicks(payload => channels.emit(IPC_EVENTS.NOTIFICATION_CLICK, payload));
	mountConnectionBanner(transport, document, translate);

	// Push, install guidance and the update watcher, for the notification controls in Settings.
	const pwa = createBrowserPwa({ registration, features: () => transport.features, update: null });
	setWebPwa(pwa);

	// Updates apply by themselves (sw-update.ts), only while the page is not in use: at launch, or when it comes back
	// after being hidden at least 30 s, before the first touch or key (`gate`), and then only when the composer is
	// empty, no file pick is in progress, nothing waits for an answer and no upload is on its way (`moment`, which
	// exists once the app and its stores have loaded; until then nothing is safe). A page the host no longer talks to
	// (`outdated`) is useless as it is and waits only for the safe moment.
	const applyUpdate = () => {
		if (!moment) return;
		if (transport.state === "outdated") {
			if (pwa.update) pwa.update.resume(moment);
			else if (safeToReload(moment)) void purgeNow();
			return;
		}
		if (!gate.open(Date.now())) return;
		if (pwa.update) pwa.update.resume(moment);
		else if (chunkStale && safeToReload(moment)) void purgeNow();
	};
	void registration.then(registered => {
		if (!registered) return;
		const watcher = new UpdateWatcher(registered, navigator.serviceWorker, () => reloadNow("update"), purgeNow);
		if (transport.state === "outdated" || chunkStale) watcher.markOutdated();
		pwa.update = watcher;
		// A build that finishes installing within the launch or return moment is applied then, not a visit later.
		watcher.onChange(applyUpdate);
		applyUpdate();
	});
	transport.onState(state => {
		// The reasons of the reloads that led here reach the host's runtime log on each connect.
		if (state === "open") flushReloadReasons(localStorage, report => web.api.runtime.report(report));
		if (state !== "outdated") return;
		pwa.update?.markOutdated();
		applyUpdate();
	});

	document.addEventListener("visibilitychange", () => {
		const visible = document.visibilityState === "visible";
		transport.setPresence(visible);
		if (!visible) {
			gate.hidden(Date.now());
			lastResort?.recheck();
			return;
		}
		gate.shown(Date.now());
		transport.wake();
		applyUpdate();
		lastResort?.recheck();
		void pwa.update?.check().then(applyUpdate);
	});
	// The page is in use from the first touch, key or wheel on: no update or last-resort reload lands until it was
	// away again. (A scroll alone is not counted: the transcript scrolls itself while a reply streams.)
	for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
		window.addEventListener(type, () => gate.used(), { capture: true, passive: true });
	}
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
	appLoaded.resolve();
	moment = (await import("./safe-moment")).pageSafeMoment();
	gate.launched(Date.now());
	applyUpdate();
	// A chunk that will not load marks the page outdated: it reloads through the same gate as an update, never with
	// a prompt. When the failure took the whole app down the composer's text was saved as it unmounted, so the page
	// reloads once hidden or at a launch/return moment (`reloadWhenUnused`) unless a picture, an unsaved edit, a pick
	// or an upload would be lost (`appGoneMoment`).
	const { useChunkFailureStore } = await import("../lib/chunk-load");
	const onChunkFailure = ({ failed, appGone }: { failed: boolean; appGone: boolean }) => {
		const current = moment;
		if (!failed || !current) return;
		if (!chunkStale) {
			chunkStale = true;
			pwa.update?.markOutdated();
			applyUpdate();
		}
		if (appGone && !lastResort) lastResort = reloadWhenUnused(appGoneMoment(current), gate, purgeNow);
	};
	useChunkFailureStore.subscribe(onChunkFailure);
	onChunkFailure(useChunkFailureStore.getState());
	// Reconnects that missed events catch up in place from here on (resync.ts); a reload is the last resort, after
	// three failed passes, and waits until nobody uses the page. Dynamic like the stores above: resync-page.ts reads
	// them, and they must not evaluate before `window.omp` exists.
	const { resyncPage } = await import("./resync-page");
	resync = new PageResync({
		run: async () => {
			if (!(await resyncPage()) || transport.state !== "open") return false;
			for (const listener of [...resyncListeners]) listener();
			return true;
		},
		giveUp: failures => {
			const current = moment;
			if (!current) return;
			lastResort = reloadWhenUnused(current, gate, () =>
				reloadNow("resync-failed", { failures, cause: resyncCause ?? "missed-events" }),
			);
		},
	});
	if (resyncCause) resync.request();
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

	// One quiet "install the app" hint from the second visit on, once the browser had time to offer its prompt.
	recordVisit(localStorage, sessionStorage);
	window.setTimeout(() => {
		showInstallHintIfDue({
			local: localStorage,
			guidance: () => pwa.guidance(),
			show: () => {
				void import("../stores/toast").then(({ useToastStore }) =>
					useToastStore.getState().push({
						variant: "info",
						message: translate("web.install.hint"),
						action: { label: translate("web.install.menu"), run: startInstall },
						durationMs: INSTALL_HINT_MS,
					}),
				);
			},
		});
	}, INSTALL_HINT_DELAY_MS);
}

async function boot(): Promise<void> {
	document.documentElement.dataset.platform = "web";
	// The current language's strings download beside the app (main.tsx waits for them before its first render).
	void loadLocale(getCurrentLanguage());
	if (location.pathname === "/pair") {
		const { renderPairScreen } = await import("./pair-boot");
		renderPairScreen();
		return;
	}
	await bootApp();
}

void boot();
