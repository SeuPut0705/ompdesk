import { VISUAL_SCHEME } from "../../shared/preview";

/** Which visual and version an `omp-visual:` address names, or null. */
export function parseVisualUrl(url: string): { id: string; version: number } | null {
	try {
		const parsed = new URL(url);
		const match = parsed.protocol === `${VISUAL_SCHEME}:` ? /^v(\d+)-([0-9a-f]{16})$/.exec(parsed.hostname) : null;
		return match ? { id: match[2]!, version: Number(match[1]) } : null;
	} catch {
		return null;
	}
}

/**
 * Whether a page in the visual session, showing visual `shown` (null: an empty document), may go to `to` when
 * the page itself asks: a link, `location`, a form, a meta refresh, a frame's load, a redirect. Only another
 * version of the same visual or an empty document (`about:blank`, `about:srcdoc`, which keep the page's origin
 * and policy) qualify, so nothing the page read leaves in an address. Main's own loads (`loadVisual`, history)
 * never come through here.
 */
export function visualMayNavigate(shown: string | null, to: string): boolean {
	let target: URL;
	try {
		target = new URL(to);
	} catch {
		return false;
	}
	if (target.protocol === "about:") return target.pathname === "blank" || target.pathname === "srcdoc";
	return shown !== null && parseVisualUrl(to)?.id === shown;
}
