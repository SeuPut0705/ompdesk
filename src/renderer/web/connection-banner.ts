/**
 * The link's state on the page: a bar under the status bar once the connection to the computer has been down
 * or in the making for `LINK_NOTICE_GRACE_MS` (a drop that heals sooner, like the page coming back from the
 * background, shows nothing). A host that needs a newer page has no notice: the page reloads itself
 * (sw-update.ts). Plain DOM, so it shows even when the app has not rendered (a host that is off, a bundle
 * that failed). Text through `t` (lib/i18n `translate`).
 */
import { LINK_NOTICE_GRACE_MS } from "../../shared/link-notice";
import type { WsConnectionState } from "./ws-transport";

const BANNER_ID = "omp-web-connection";

export interface BannerSource {
	readonly state: WsConnectionState;
	onState(listener: (state: WsConnectionState) => void): () => void;
}

export function mountConnectionBanner(
	source: BannerSource,
	doc: Document,
	t: (key: string) => string,
	setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
	clearTimer: (handle: unknown) => void = handle => clearTimeout(handle as number),
): () => void {
	let graceTimer: unknown = null;

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
	const show = (key: string) => {
		element().textContent = t(key);
	};
	const hide = () => doc.getElementById(BANNER_ID)?.remove();

	const apply = (state: WsConnectionState) => {
		if (graceTimer !== null) {
			clearTimer(graceTimer);
			graceTimer = null;
		}
		switch (state) {
			case "open":
			case "closed":
				hide();
				return;
			case "reconnecting":
				graceTimer = setTimer(() => show("web.connection.lost"), LINK_NOTICE_GRACE_MS);
				return;
			case "connecting":
				graceTimer = setTimer(() => show("web.connection.connecting"), LINK_NOTICE_GRACE_MS);
				return;
			case "outdated":
				// The page reloads itself at a safe moment (web-boot.ts); a bar would only ask the user to do it.
				hide();
				return;
			case "unpaired":
				show("web.connection.unpaired");
				return;
		}
	};

	apply(source.state);
	return source.onState(apply);
}
