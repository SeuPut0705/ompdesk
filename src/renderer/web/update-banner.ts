/**
 * "Update available — Reload": a bar at the bottom of the page once a newer build waits in the service worker
 * (sw-update.ts `UpdateWatcher`). Plain DOM like the connection banner, so it shows whatever state the app is in.
 * Text through `t` (lib/i18n `translate`).
 */

const BANNER_ID = "omp-web-update";

export interface UpdateSource {
	readonly available: boolean;
	onChange(listener: () => void): () => void;
	apply(): void;
}

export function mountUpdateBanner(source: UpdateSource, doc: Document, t: (key: string) => string): () => void {
	const show = () => {
		if (doc.getElementById(BANNER_ID)) return;
		const bar = doc.createElement("div");
		bar.id = BANNER_ID;
		bar.setAttribute("role", "status");
		bar.setAttribute("aria-live", "polite");
		bar.style.cssText =
			"position:fixed;left:calc(env(safe-area-inset-left,0px) + 8px);right:calc(env(safe-area-inset-right,0px) + 8px);bottom:calc(var(--kb-inset,0px) + var(--safe-b,env(safe-area-inset-bottom,0px)) + 8px);z-index:2147483000;" +
			"display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 12px;border-radius:10px;" +
			"font:500 13px/1.3 system-ui,sans-serif;background:var(--sc-surface-2,#fff);color:var(--sc-text,#1a1a1a);" +
			"border:1px solid var(--sc-border,#d0d0d0);box-shadow:0 4px 16px rgba(0,0,0,.2)";
		const text = doc.createElement("span");
		text.textContent = t("web.update.available");
		const button = doc.createElement("button");
		button.type = "button";
		button.textContent = t("web.update.reload");
		button.style.cssText =
			"min-height:36px;padding:0 14px;border-radius:8px;border:0;font:inherit;font-weight:600;" +
			"background:var(--sc-accent,#5b5bd6);color:var(--sc-on-accent,#fff);cursor:pointer";
		button.addEventListener("click", () => {
			button.disabled = true;
			source.apply();
		});
		bar.append(text, button);
		doc.body.append(bar);
	};
	if (source.available) show();
	return source.onChange(() => {
		if (source.available) show();
	});
}
