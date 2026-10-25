/**
 * What the desktop shows in the dock and window chrome, as a web page shows it (ipc-policy: `TRAY_STATE_PUSH`,
 * `PROGRESS_SET`, `WINDOW_CHROME_SET` → "app badge and document title", "top progress bar", `theme-color`).
 */
import type { RunProgressState, TrayState, WindowChromeColors } from "../../shared/ipc-types";

interface BadgeNavigator {
	setAppBadge?: (count?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
}

export interface ChromeDeps {
	document: Document;
	navigator: BadgeNavigator;
}

const PROGRESS_ID = "omp-web-progress";
const ATTENTION_PREFIX = "(!) ";

export class WebChrome {
	readonly #deps: ChromeDeps;
	#baseTitle: string | null = null;

	constructor(deps: ChromeDeps) {
		this.#deps = deps;
	}

	/** The session needs the person (a question, an approval, a waiting child, a failed check): a badge and a title mark. */
	applyTray(state: TrayState): void {
		const attention = state.status !== "idle" && state.status !== "streaming" && state.status !== "error";
		const doc = this.#deps.document;
		const current = doc.title;
		if (this.#baseTitle === null || (!current.startsWith(ATTENTION_PREFIX) && current !== this.#baseTitle)) {
			this.#baseTitle = current.startsWith(ATTENTION_PREFIX) ? current.slice(ATTENTION_PREFIX.length) : current;
		}
		doc.title = attention ? `${ATTENTION_PREFIX}${this.#baseTitle}` : this.#baseTitle;
		const nav = this.#deps.navigator;
		if (attention) void nav.setAppBadge?.(1).catch(() => undefined);
		else void nav.clearAppBadge?.().catch(() => undefined);
	}

	/** A thin bar along the top edge while the agent works or waits for the user. */
	applyProgress(state: RunProgressState): void {
		const doc = this.#deps.document;
		let bar = doc.getElementById(PROGRESS_ID);
		if (state === "idle") {
			bar?.remove();
			return;
		}
		if (!bar) {
			bar = doc.createElement("div");
			bar.id = PROGRESS_ID;
			bar.setAttribute("role", "presentation");
			bar.style.cssText =
				"position:fixed;top:0;left:0;right:0;height:2px;z-index:2147483000;pointer-events:none;" +
				"background:var(--sc-accent, #6e70ee);transform-origin:left";
			doc.body.append(bar);
		}
		bar.style.opacity = state === "waiting" ? "0.45" : "1";
	}

	/** The status-bar color of an installed page follows the app's top bar. */
	applyColors(colors: WindowChromeColors): void {
		const doc = this.#deps.document;
		// The page ships a light and a dark `theme-color` chosen by the OS scheme; the app's own top bar wins
		// over both once it reports its color.
		const metas = Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
		if (metas.length === 0) {
			const created = doc.createElement("meta");
			created.name = "theme-color";
			doc.head.append(created);
			metas.push(created);
		}
		for (const meta of metas) {
			meta.removeAttribute("media");
			meta.content = colors.color;
		}
	}
}
