/**
 * Desktop notifications from the renderer (`SYSTEM_NOTIFY`): the per-window repeat filter, and the judge-model
 * triage of a completion (resources/gui-bridge/modes/judge-assist-contracts.ts). A finished turn whose last reply
 * waits for the person is shown as `ask` ("Needs your answer · <tab>", the question word of every attention surface),
 * which notification-batch.ts already ranks above errors and completions; anything else is the completion exactly as
 * the renderer sent it.
 *
 * It lives in main, not the renderer: a renderer RPC would meter a paired web page's quota and make a hidden phone
 * the tab's driver even with no judge, add a round trip to every banner, and let two windows that show one tab
 * classify differently. Here the repeat filter runs first, so one tab end is classified once whichever window
 * reports it, and the question goes straight to the tab's own bridge (no RPC dispatch).
 *
 * Only an addition: the pref `judgeAssist` off, a tab that is not this machine's own local omp (a paired host's tab,
 * a view of a tab this computer hosts), no native judge, a streaming session, an error or a timeout all end as the
 * unchanged completion.
 */
import { JUDGE_ASSIST_NEEDS_USER, type NeedsUserResult } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import type { IpcNotifyPayload } from "../shared/ipc-types";
import type { ClientWindow } from "./web/client-window";

/** The repeat window: one turn can emit the same notification from several renderers. */
export const NOTIFY_DEDUPE_MS = 1500;
/** The bridge answers within 2 s (JUDGE_ASSIST_TIMEOUT_MS); a little more, then the completion shows as it was. */
export const NEEDS_USER_WAIT_MS = 2500;

/** A direct request to a tab's own bridge: no RPC dispatch, so no quota and no driver. */
export type BridgeAsk = (method: string, params: unknown) => Promise<unknown>;

export interface NotifyTriageDeps {
	now(): number;
	/** A tab several windows show is one event, whichever of them reports it. */
	isShared(tabId: string): boolean;
	/** The pref `judgeAssist` (default on). */
	judgeEnabled(): boolean;
	/** The bridge of `tabId` when it is a local tab of this machine owned by `win`; undefined for any other. */
	bridgeFor(win: ClientWindow, tabId: string): BridgeAsk | undefined;
	/** The title of a needs-you notice, in the app's language. */
	needsYouTitle(title: string): string;
	/** Hand the notice on (window bookkeeping and the batcher). */
	deliver(win: ClientWindow | null, winId: number, notice: IpcNotifyPayload): void;
}

export interface NotifyCaller {
	readonly win: ClientWindow | null;
	/** The Electron window of a desktop caller; null for a web caller (its page already checked its own focus). */
	readonly browserWindow: { isFocused(): boolean } | null;
}

export function createNotifyHandler(
	deps: NotifyTriageDeps,
): (caller: NotifyCaller, payload: IpcNotifyPayload) => Promise<void> {
	let lastKey = "";
	let lastAt = 0;

	async function asksTheUser(ask: BridgeAsk): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<null>(resolve => {
			timer = setTimeout(() => resolve(null), NEEDS_USER_WAIT_MS);
		});
		try {
			const result = (await Promise.race([ask(JUDGE_ASSIST_NEEDS_USER, {}), expired])) as NeedsUserResult | null;
			return result?.needsUser === true;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	return async (caller, payload) => {
		if (typeof payload.title !== "string") return;
		// Dedupe within a window, but NOT across windows: two parallel sessions finishing in different windows are
		// distinct events the user wants. A tab several windows show is one event, whichever of them reports it.
		const win = caller.win;
		const winId = win?.webContents.id ?? 0;
		const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
		const scope = tabId && deps.isShared(tabId) ? `tab:${tabId}` : winId;
		const key = `${scope}${payload.title}${payload.body ?? ""}`;
		const now = deps.now();
		if (key === lastKey && now - lastAt < NOTIFY_DEDUPE_MS) return;
		lastKey = key;
		lastAt = now;

		const ask =
			payload.kind === "completion" && tabId && win && deps.judgeEnabled() ? deps.bridgeFor(win, tabId) : undefined;
		if (!ask || !(await asksTheUser(ask))) {
			deps.deliver(win, winId, payload);
			return;
		}
		// The person came back while the judge answered: the banner is not needed for the reply's sake, but the
		// notification itself is still the renderer's to show as it sent it.
		if (caller.browserWindow?.isFocused()) {
			deps.deliver(win, winId, payload);
			return;
		}
		deps.deliver(win, winId, { ...payload, title: deps.needsYouTitle(payload.title), kind: "ask" });
	};
}
