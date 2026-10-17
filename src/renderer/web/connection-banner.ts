/**
 * The link's state on the page: a bar under the status bar while the connection to the computer is down or
 * being made, and a notice when the host needs a newer page. Plain DOM, so it shows even when the app has not
 * rendered (a host that is off, a bundle that failed). Text through `t` (lib/i18n `translate`).
 */
import type { WsConnectionState } from "./ws-transport";

const BANNER_ID = "omp-web-connection";
/** A first connection that takes longer than this shows the bar (a quick one never flashes it). */
const CONNECTING_GRACE_MS = 2500;

export interface BannerSource {
	readonly state: WsConnectionState;
	onState(listener: (state: WsConnectionState) => void): () => void;
}

export interface BannerActions {
	/** "Reload": the host needs a newer page; drop the cached one and load again. */
	reload(): void;
}

export function mountConnectionBanner(
	source: BannerSource,
	doc: Document,
	t: (key: string) => string,
	setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
	clearTimer: (handle: unknown) => void = handle => clearTimeout(handle as number),
	actions?: BannerActions,
): () => void {
	let connectingTimer: unknown = null;

	const element = () => {
		let bar = doc.getElementById(BANNER_ID);
		if (!bar) {
			bar = doc.createElement("div");
			bar.id = BANNER_ID;
			bar.setAttribute("role", "status");
			bar.setAttribute("aria-live", "polite");
			bar.style.cssText =
				"position:fixed;left:0;right:0;top:0;z-index:2147483001;padding:calc(env(safe-area-inset-top,0px) + 6px) calc(env(safe-area-inset-right,0px) + 12px) 6px calc(env(safe-area-inset-left,0px) + 12px);" +
				"text-align:center;font:500 13px/1.3 system-ui,sans-serif;background:var(--sc-warning-soft,#fff3cd);" +
				"color:var(--sc-text,#1a1a1a);border-bottom:1px solid var(--sc-border,#d0d0d0)";
			doc.body.append(bar);
		}
		return bar;
	};
	const show = (key: string, action?: { label: string; run: () => void }) => {
		const bar = element();
		if (!action) {
			bar.textContent = t(key);
			return;
		}
		const button = doc.createElement("button");
		button.type = "button";
		button.textContent = action.label;
		button.style.cssText =
			"margin-inline-start:10px;min-height:28px;padding:0 12px;border-radius:6px;border:1px solid currentColor;" +
			"font:inherit;font-weight:600;background:transparent;color:inherit;cursor:pointer";
		button.addEventListener("click", () => {
			button.disabled = true;
			action.run();
		});
		bar.replaceChildren(doc.createTextNode(t(key)), button);
	};
	const hide = () => doc.getElementById(BANNER_ID)?.remove();

	const apply = (state: WsConnectionState) => {
		if (connectingTimer !== null) {
			clearTimer(connectingTimer);
			connectingTimer = null;
		}
		switch (state) {
			case "open":
			case "closed":
				hide();
				return;
			case "reconnecting":
				show("web.connection.lost");
				return;
			case "connecting":
				connectingTimer = setTimer(() => show("web.connection.connecting"), CONNECTING_GRACE_MS);
				return;
			case "outdated":
				show(
					"web.connection.outdated",
					actions ? { label: t("web.update.reload"), run: () => actions.reload() } : undefined,
				);
				return;
			case "unpaired":
				show("web.connection.unpaired");
				return;
		}
	};

	apply(source.state);
	return source.onState(apply);
}
