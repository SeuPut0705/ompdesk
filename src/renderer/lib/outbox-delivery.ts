/**
 * Sends what waits in the outbox (stores/outbox.ts) once the link to the computer running its session is back:
 * each session's items one at a time, oldest first, each to the tab that holds the session now (a computer that
 * restarted gave it a new id). A message goes as a `prompt` that says how to join a run (`streamingBehavior`): the
 * host decides at arrival whether it starts a turn or joins the one going, whatever the session did meanwhile. Every
 * try carries the item's id as `deliveryId`, so a try whose answer the link lost and the next one reach omp once
 * (main's delivery-ledger.ts).
 *
 * A try the link cut, or a computer not ready yet, waits for the next change. A message the computer refused stays
 * as failed and holds back the ones after it until the person tries it again, edits it or cancels it. An answer to a
 * question goes only to the process that asked, and only while that question is still open there; one answered
 * elsewhere or closed meanwhile is dropped with a toast that says so.
 */
import { useSyncExternalStore } from "react";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { BLOCKING_UI_METHODS, type ExtensionUIResponse, type RpcResponse } from "../../shared/rpc-types";
import type { ExtensionUiStore } from "../stores/extension-ui";
import { useInputHistoryStore } from "../stores/input-history";
import type { MessagesStore } from "../stores/messages";
import { type OutboxItem, type OutboxSend, outboxFor, outboxSession, useOutboxStore } from "../stores/outbox";
import { useRemoteStore } from "../stores/remote";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { webRuntime } from "../web/runtime";
import type { WsConnectionState } from "../web/ws-transport";
import { translate } from "./i18n";
import { createTabRpc } from "./tab-rpc";

type LinkedTab = Pick<SessionTab, "device">;

/** The link to the computer that runs `tab` is up (a host this window does not know yet counts as up). */
function linkUp(tab: LinkedTab): boolean {
	const web = webRuntime();
	if (web && web.connectionState() !== "open") return false;
	if (tab.device === undefined) return true;
	const host = useRemoteStore.getState().state?.hosts.find(entry => entry.deviceId === tab.device);
	return host === undefined || host.state === "online";
}

/** What the person sends to `tab` now waits in the outbox instead of going: its link is down. */
export function sendsHeld(tab: LinkedTab | undefined): boolean {
	return tab !== undefined && (webRuntime() !== null || tab.device !== undefined) && !linkUp(tab);
}

function webState(): WsConnectionState | null {
	return webRuntime()?.connectionState() ?? null;
}
function subscribeWebState(listener: () => void): () => void {
	return webRuntime()?.onConnectionState(listener) ?? (() => {});
}

/** `sendsHeld` for tab `tabId`, kept current as the page's or the paired host's link comes and goes. */
export function useSendsHeld(tabId: string | null): boolean {
	const web = useSyncExternalStore(subscribeWebState, webState);
	const device = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.device);
	const hostState = useRemoteStore(state => state.state?.hosts.find(entry => entry.deviceId === device)?.state);
	if (tabId === null) return false;
	if (web !== null && web !== "open") return true;
	return device !== undefined && hostState !== undefined && hostState !== "online";
}

/** Keep a message for `tab` until its link is back (the composer's send while `sendsHeld`). */
export function holdMessage(tab: SessionTab, send: Omit<Extract<OutboxSend, { kind: "message" }>, "kind">): void {
	useOutboxStore.getState().hold({
		id: crypto.randomUUID(),
		session: outboxSession(tab),
		at: Date.now(),
		state: "held",
		send: { kind: "message", ...send },
	});
}

/** The person's answer, in words, for the outbox's chip and its toasts. */
function answerSummary(response: ExtensionUIResponse): string {
	if ("cancelled" in response) return translate("outbox.answerDismissed");
	if ("confirmed" in response) return translate(response.confirmed ? "common.yes" : "common.no");
	if ("answers" in response)
		return response.answers
			.flatMap(answer => [...answer.selectedOptions, ...(answer.customInput ? [answer.customInput] : [])])
			.join(", ");
	return response.value;
}

/** Keep an answer to a question card of `tab` until its link is back; the card closes meanwhile. */
export function holdAnswer(tab: SessionTab, response: ExtensionUIResponse): void {
	const request = sessionRuntimeStore<ExtensionUiStore>(tab.id, "extensionUi")
		?.getState()
		.pendingRequests.find(pending => pending.id === response.id);
	useOutboxStore.getState().hold({
		id: crypto.randomUUID(),
		session: outboxSession(tab),
		at: Date.now(),
		state: "held",
		send: {
			kind: "answer",
			tabId: tab.id,
			response,
			...(request ? { request } : {}),
			summary: answerSummary(response),
		},
	});
}

/** Answers that mean "not now", never "no": the link or the computer's tab is not there yet. */
const LATER_CODES: Record<string, true> = {
	remote_offline: true,
	rpc_delivery_unknown: true,
	sidecar_not_connected: true,
	sidecar_not_ready: true,
	unknown_tab: true,
	no_window: true,
};

type Outcome = "delivered" | "later" | { failed: string };

async function deliverMessage(item: OutboxItem, tab: SessionTab): Promise<Outcome> {
	if (item.send.kind !== "message") return "delivered";
	const { text, images, behavior } = item.send;
	// The host's echo of this message is this page's own, not "from another device".
	sessionRuntimeStore<MessagesStore>(tab.id, "messages")?.getState().noteOwnSend(text);
	let response: RpcResponse;
	try {
		response = await window.omp.rpc.commandForTab(tab.id, {
			type: "prompt",
			message: text,
			images,
			streamingBehavior: behavior,
			deliveryId: item.id,
		});
	} catch (error) {
		if (!linkUp(tab)) return "later";
		return { failed: error instanceof Error ? error.message : String(error) };
	}
	if (response.success) {
		const rpc = createTabRpc(command => window.omp.rpc.commandForTab(tab.id, command));
		useInputHistoryStore.getState().record(text, tab.cwd, rpc, tab.device);
		return "delivered";
	}
	if ((response.code && LATER_CODES[response.code]) || !linkUp(tab)) return "later";
	return { failed: response.error ?? translate("input.sendFailed") };
}

/**
 * Reads of the computer's open questions that may miss an answer's question before it is called closed: right after
 * the link is back the computer may not have handed this window its open questions yet.
 */
const CLOSED_AFTER_MISSES = 3;

async function deliverAnswer(item: OutboxItem, tab: SessionTab): Promise<Outcome> {
	if (item.send.kind !== "answer") return "delivered";
	const { response, request, summary } = item.send;
	// The tab's omp is not the one that asked (the computer restarted): the question went with it.
	if (tab.id !== item.send.tabId) {
		toast({ variant: "warning", message: translate("outbox.answerClosed", { summary }) });
		return "delivered";
	}
	// omp drops an answer to a question it no longer asks without a word: only one still open is sent.
	if (request && BLOCKING_UI_METHODS[request.method] === true) {
		let open: boolean;
		try {
			open = (await window.omp.ui.openRequests()).some(
				entry => entry.tabId === tab.id && entry.request.id === response.id,
			);
		} catch {
			return "later";
		}
		if (!open) {
			const misses = (item.misses ?? 0) + 1;
			if (misses < CLOSED_AFTER_MISSES) {
				useOutboxStore.getState().patch(item.id, { misses });
				return "later";
			}
			toast({ variant: "warning", message: translate("outbox.answerClosed", { summary }) });
			return "delivered";
		}
	}
	try {
		await window.omp.ui.respondExtensionUi(response, tab.id);
		return "delivered";
	} catch (error) {
		const code = ipcErrorCode(error);
		if (code === "already_answered") {
			// A try that may have arrived: the refusal can be of that same answer.
			if (!item.tried) toast({ variant: "info", message: translate("outbox.answerElsewhere", { summary }) });
			return "delivered";
		}
		if (!linkUp(tab) || (code && LATER_CODES[code])) return "later";
		toast({ variant: "warning", message: translate("outbox.answerClosed", { summary }) });
		return "delivered";
	}
}

/** The live tab that holds `session` and can take what waits for it now; null while none can. */
function readyTab(session: string): SessionTab | null {
	const tab = useTabsStore
		.getState()
		.tabs.find(
			entry =>
				!entry.ghost &&
				(entry.status === "ready" || entry.status === "running") &&
				outboxSession(entry) === session,
		);
	return tab && linkUp(tab) ? tab : null;
}

const RETRY_MS = 2000;
let running = false;
let rerun = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Deliver what can go now; a pass under way runs once more after it. */
function deliverOutbox(): void {
	if (running) {
		rerun = true;
		return;
	}
	running = true;
	void pass().finally(() => {
		running = false;
		if (rerun) {
			rerun = false;
			deliverOutbox();
		}
	});
}

async function pass(): Promise<void> {
	const { items, patch, drop } = useOutboxStore.getState();
	let waiting = false;
	for (const session of new Set(items.map(item => item.session))) {
		for (const queued of outboxFor(items, session)) {
			// Read again: the person may have cancelled or edited it while the one before it went.
			const item = useOutboxStore.getState().items.find(entry => entry.id === queued.id);
			if (!item) continue;
			if (item.state === "failed") break;
			const tab = readyTab(session);
			if (!tab) break;
			patch(item.id, { state: "sending" });
			const outcome =
				item.send.kind === "message" ? await deliverMessage(item, tab) : await deliverAnswer(item, tab);
			if (outcome === "delivered") {
				drop(item.id);
				continue;
			}
			if (!useOutboxStore.getState().items.some(entry => entry.id === item.id)) continue;
			if (outcome === "later") {
				patch(item.id, { state: "held", tried: true });
				waiting = true;
			} else patch(item.id, { state: "failed", error: outcome.failed });
			break;
		}
	}
	clearTimeout(retryTimer);
	retryTimer = waiting ? setTimeout(deliverOutbox, RETRY_MS) : undefined;
}

/**
 * Watch everything that can let a waiting item go (the page's link, a paired host's link, a tab becoming ready or
 * taking the session, a new item) for the life of the window. Returns the stop.
 */
export function installOutboxDelivery(): () => void {
	const stops = [
		// A new item, or one the person tries again; never this pass's own "held again", which waits for a change.
		useOutboxStore.subscribe((next, previous) => {
			const due = next.items.some(item => {
				if (item.state !== "held") return false;
				const before = previous.items.find(old => old.id === item.id);
				return before === undefined || before.state === "failed";
			});
			if (due) deliverOutbox();
		}),
		useTabsStore.subscribe((next, previous) => {
			if (next.tabs !== previous.tabs && useOutboxStore.getState().items.length > 0) deliverOutbox();
		}),
		useRemoteStore.subscribe((next, previous) => {
			if (next.state !== previous.state && useOutboxStore.getState().items.length > 0) deliverOutbox();
		}),
	];
	const web = webRuntime();
	if (web) stops.push(web.onConnectionState(state => state === "open" && deliverOutbox()));
	deliverOutbox();
	return () => {
		for (const stop of stops) stop();
		clearTimeout(retryTimer);
	};
}
