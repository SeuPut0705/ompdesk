/**
 * Web Push for paired phones, driven by what tabs do (`SidecarPool.observeTabs`): a turn that settled idle (after
 * a short debounce, so a retry or a follow-up that restarts it stays quiet), a failed turn, a blocking ask, and an
 * ask that went away (answered by any window, withdrawn, its tab ended), which retracts its notification with a
 * silent `clear` push.
 *
 * The rules are the desktop banners' (notification-batch.ts): ask > error > completion, one entry per tab, the first
 * event of a burst at once and one summary at the end of the 4 s window. Each device has its own window (its id is the
 * "window" of a `NotificationBatcher` kept for pushes), fed only the categories the device switched on. A device
 * with a page in the foreground is never pushed (`visible`): its page shows an in-app toast. A device that hides
 * content gets generic titles and no body. The text follows the host's UI language.
 */
import type { IpcTabRunOutcome } from "../../shared/ipc-types";
import { notificationSummary } from "../../shared/notification-summary";
import type { UiLanguage } from "../../shared/ui-language";
import type { WebPushPayload, WebPushSettings } from "../../shared/web-push";
import { MAIN_TEXT } from "../i18n-text";
import { type NoticeKind, NotificationBatcher, type ShownInfo, type ShownNotice } from "../notification-batch";
import type { TabActivity, TabFacts } from "../sidecar-pool";
import { pushSettingsOf, type WebDevice } from "./devices-store";
import type { PushOptions, PushResult } from "./push";

/** A settle is announced this long after it, unless the tab started running again (a retry, a queued follow-up). */
export const COMPLETION_DEBOUNCE_MS = 1500;

const TTL_ASK_S = 6 * 60 * 60;
const TTL_NEWS_S = 60 * 60;
const TTL_CLEAR_S = 2 * 60;
const TITLE_MAX = 120;
const BODY_MAX = 240;
const ERROR_DETAIL_MAX = 120;
const FALLBACK_TITLE = "OMPdesk";

export interface WebPushNotifierDeps {
	devices: {
		list(): WebDevice[];
		get(deviceId: string): WebDevice | undefined;
		forgetPushSubscription(deviceId: string, endpoint: string): boolean;
	};
	sender: {
		send(
			subscription: NonNullable<WebPushSettings["subscription"]>,
			payload: WebPushPayload,
			options: PushOptions,
		): Promise<PushResult>;
	};
	/** The device has a socket open with its page in the foreground (`WsRouter.isDeviceVisible`). */
	visible: (deviceId: string) => boolean;
	/** A live tab's facts (`SidecarPool.tabFacts`); null once the tab is gone. */
	tabFacts: (tabId: string) => TabFacts | null;
	language: () => UiLanguage;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	/**
	 * Whether a turn's end or a question of the tab may push at all: the bot's tabs push where the owner routed their
	 * kind (`agent-control/bot-notify.ts`); every other tab always may.
	 */
	pushes?: (tabId: string, kind: "completion" | "ask") => boolean;
}

interface OpenAsk {
	tabId: string;
	/** Devices a push for this ask went to (a lone ask banner), the ones a `clear` must reach. */
	pushedTo: Set<string>;
	/** Devices whose notification window this ask was fed into (a summary may carry it). */
	fedTo: Set<string>;
}

function text(key: keyof typeof MAIN_TEXT, language: UiLanguage, params?: Record<string, string>): string {
	return MAIN_TEXT[key][language].replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
}

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class WebPushNotifier {
	readonly #deps: WebPushNotifierDeps;
	readonly #batcher: NotificationBatcher;
	/** Per-device "window" ids of the batcher, both ways. */
	readonly #keyOf = new Map<string, number>();
	readonly #deviceOf = new Map<number, string>();
	#nextKey = 1;
	/** Debounce timers of settled tabs. */
	readonly #settling = new Map<string, unknown>();
	/** Run outcomes already announced: compaction or a background job may settle the same run again. */
	readonly #announced = new WeakSet<IpcTabRunOutcome>();
	readonly #asks = new Map<string, OpenAsk>();
	/** The tag a device's next summary replaces (the banner it closed). */
	readonly #replacing = new Map<number, string>();

	constructor(deps: WebPushNotifierDeps) {
		this.#deps = deps;
		this.#batcher = new NotificationBatcher({
			show: (key, notice, info) => this.#show(key, notice, info),
			language: deps.language,
			setTimer: deps.setTimer,
			clearTimer: deps.clearTimer,
		});
	}

	/** `SidecarPool.observeTabs`'s listener. */
	handle(activity: TabActivity): void {
		switch (activity.type) {
			case "busy":
				this.#cancelSettle(activity.tabId);
				return;
			case "idle":
				this.#settled(activity.tabId, activity.outcome);
				return;
			case "ask":
				this.#ask(activity.tabId, activity.requestId, activity.text);
				return;
			case "askClosed":
				this.#askClosed(activity.requestId);
				return;
			case "released":
				this.#cancelSettle(activity.tabId);
				for (const [requestId, ask] of [...this.#asks])
					if (ask.tabId === activity.tabId) this.#askClosed(requestId);
				return;
		}
	}

	/**
	 * A notice of tab `tabId` no turn event carries (an Autopilot run's end, an agent's `ompdesk_notify`): every
	 * device that wants the kind hears it, like a turn of that tab.
	 */
	notice(tabId: string, notice: { kind: "completion" | "error"; title: string; body: string }): void {
		this.#feed(notice.kind, tabId, notice.title, notice.body);
	}

	/** A device was revoked: its pending summary has nobody to go to. */
	dropDevice(deviceId: string): void {
		const key = this.#keyOf.get(deviceId);
		if (key === undefined) return;
		this.#batcher.dropWindow(key);
		this.#replacing.delete(key);
		this.#keyOf.delete(deviceId);
		this.#deviceOf.delete(key);
		for (const ask of this.#asks.values()) {
			ask.pushedTo.delete(deviceId);
			ask.fedTo.delete(deviceId);
		}
	}

	dispose(): void {
		for (const timer of this.#settling.values()) this.#deps.clearTimer(timer);
		this.#settling.clear();
		this.#batcher.dispose();
		this.#asks.clear();
	}

	#cancelSettle(tabId: string): void {
		const timer = this.#settling.get(tabId);
		if (timer === undefined) return;
		this.#deps.clearTimer(timer);
		this.#settling.delete(tabId);
	}

	#settled(tabId: string, outcome: IpcTabRunOutcome | undefined): void {
		// No run ended (a compaction finished), one already announced, or Stop: nothing to tell.
		if (!outcome || this.#announced.has(outcome) || outcome.stopReason === "aborted") return;
		this.#cancelSettle(tabId);
		this.#settling.set(
			tabId,
			this.#deps.setTimer(() => {
				this.#settling.delete(tabId);
				this.#announceRun(tabId, outcome);
			}, COMPLETION_DEBOUNCE_MS),
		);
	}

	#announceRun(tabId: string, outcome: IpcTabRunOutcome): void {
		const facts = this.#deps.tabFacts(tabId);
		// Gone, running again, waiting for the connection or for stock's retry: the run is not over for the user.
		if (!facts || facts.busy || facts.awaitingConnection || facts.retrying) return;
		this.#announced.add(outcome);
		const language = this.#deps.language();
		if (outcome.stopReason === "error") {
			const detail = outcome.errorMessage ? clip(outcome.errorMessage, ERROR_DETAIL_MAX) : "";
			const body = detail ? text("push.errorDetail", language, { error: detail }) : text("push.error", language);
			this.#feed("error", tabId, facts.title, body);
			return;
		}
		const summary = outcome.reply ? notificationSummary(outcome.reply) : "";
		if (this.#deps.pushes?.(tabId, "completion") === false) return;
		this.#feed("completion", tabId, facts.title, summary || text("push.complete", language));
	}

	#ask(tabId: string, requestId: string, question: string): void {
		if (this.#asks.has(requestId)) return;
		const ask: OpenAsk = { tabId, pushedTo: new Set(), fedTo: new Set() };
		this.#asks.set(requestId, ask);
		if (this.#deps.pushes?.(tabId, "ask") === false) return;
		const facts = this.#deps.tabFacts(tabId);
		this.#feed("ask", tabId, facts?.title ?? "", question || text("push.ask", this.#deps.language()), ask);
	}

	/** An ask went away: its notification is retracted, wherever it was shown. */
	#askClosed(requestId: string): void {
		const ask = this.#asks.get(requestId);
		if (!ask) return;
		this.#asks.delete(requestId);
		const stillAsking = new Set<string>();
		let tabStillAsks = false;
		for (const other of this.#asks.values()) {
			if (other.tabId !== ask.tabId) continue;
			tabStillAsks = true;
			for (const deviceId of other.fedTo) stillAsking.add(deviceId);
		}
		// A pending summary must not count an answered ask (unless the tab asks something else).
		if (!tabStillAsks) for (const key of this.#deviceOf.keys()) this.#batcher.retract(key, ask.tabId);
		for (const deviceId of ask.pushedTo) {
			// Another ask of the tab still owns the tag's banner; a device looking at its page closes the banner itself.
			if (stillAsking.has(deviceId) || this.#deps.visible(deviceId)) continue;
			const clear: WebPushPayload = {
				v: 1,
				kind: "clear",
				title: "",
				body: "",
				tabId: ask.tabId,
				tag: tabTag(ask.tabId),
				silent: true,
			};
			this.#push(this.#deps.devices.get(deviceId), clear, { ttl: TTL_CLEAR_S, urgency: "normal" });
		}
	}

	/** Every device that wants `kind` and is not looking at its page gets the event into its own notification window. */
	#feed(kind: NoticeKind, tabId: string, title: string, body: string, ask?: OpenAsk): void {
		for (const device of this.#deps.devices.list()) {
			const push = pushSettingsOf(device);
			if (!push.subscription || !push.categories.includes(kind) || this.#deps.visible(device.deviceId)) continue;
			ask?.fedTo.add(device.deviceId);
			this.#batcher.notify(this.#keyFor(device.deviceId), {
				title: clip(title, TITLE_MAX) || FALLBACK_TITLE,
				body: clip(body, BODY_MAX),
				tabId,
				kind,
			});
		}
	}

	#keyFor(deviceId: string): number {
		let key = this.#keyOf.get(deviceId);
		if (key === undefined) {
			key = this.#nextKey++;
			this.#keyOf.set(deviceId, key);
			this.#deviceOf.set(key, deviceId);
		}
		return key;
	}

	/** The batcher's sink: one notification for one device's window. */
	#show(key: number, notice: ShownNotice, info: ShownInfo | null): { close: () => void } {
		const deviceId = this.#deviceOf.get(key);
		const device = deviceId === undefined ? undefined : this.#deps.devices.get(deviceId);
		const settings = device && pushSettingsOf(device);
		if (!deviceId || !device || !settings?.subscription || !info) return { close: () => undefined };
		// A summary comes seconds after its first banner: the page may have come to the foreground since.
		if (this.#deps.visible(deviceId)) return { close: () => undefined };
		const language = this.#deps.language();
		const replaced = this.#replacing.get(key);
		this.#replacing.delete(key);
		let payload: WebPushPayload;
		if (info.summary) {
			const tabs = info.summary.finished + info.summary.failed + info.summary.asks;
			payload = {
				v: 1,
				kind: "batch",
				title: notice.title,
				body: settings.hideContent ? "" : notice.body,
				...(tabs === 1 && notice.tabId ? { tabId: notice.tabId } : {}),
				tag: replaced ?? BATCH_TAG,
				silent: replaced !== undefined,
			};
		} else {
			payload = {
				v: 1,
				kind: info.kind,
				title: settings.hideContent ? text(`push.hidden.${info.kind}`, language) : notice.title,
				body: settings.hideContent ? "" : notice.body,
				...(notice.tabId ? { tabId: notice.tabId } : {}),
				tag: notice.tabId ? tabTag(notice.tabId) : BATCH_TAG,
			};
			if (info.kind === "ask" && notice.tabId) {
				for (const ask of this.#asks.values()) if (ask.tabId === notice.tabId) ask.pushedTo.add(deviceId);
			}
		}
		this.#push(device, payload, {
			ttl: info.kind === "ask" ? TTL_ASK_S : TTL_NEWS_S,
			urgency: info.kind === "ask" ? "high" : "normal",
		});
		return {
			// The summary that follows replaces this banner instead of stacking beside it.
			close: () => {
				this.#replacing.set(key, payload.tag);
			},
		};
	}

	#push(device: WebDevice | undefined, payload: WebPushPayload, options: PushOptions): void {
		const subscription = device && pushSettingsOf(device).subscription;
		if (!device || !subscription) return;
		void this.#deps.sender.send(subscription, payload, options).then(result => {
			if (result === "gone") this.#deps.devices.forgetPushSubscription(device.deviceId, subscription.endpoint);
		});
	}
}

const BATCH_TAG = "batch";

function tabTag(tabId: string): string {
	return `tab:${tabId}`;
}
