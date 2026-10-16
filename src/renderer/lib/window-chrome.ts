/**
 * Renderer half of the frameless window chrome (src/main/window-chrome.ts).
 * `html[data-platform]` lets CSS reserve room for the OS controls drawn over
 * the 48px top bar: the macOS traffic lights (top-left) and the Windows
 * caption buttons (top-right, `env(titlebar-area-*)`). On Windows the caption
 * buttons are recolored to match whatever surface sits under them.
 */

export type ChromePlatform = "darwin" | "win32" | "other" | "web";

/** `web`: a browser page (the mobile web client), whose boot marks `html[data-platform="web"]` before React mounts. */
export function chromePlatform(): ChromePlatform {
	if (typeof document !== "undefined" && document.documentElement.dataset.platform === "web") return "web";
	const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
	if (platform.startsWith("mac")) return "darwin";
	if (platform.startsWith("win")) return "win32";
	return "other";
}

/**
 * Mark the root once so stylesheets can reserve room for the window controls.
 * `data-mica`: main gave this Windows 11 window the Mica backdrop (`?mica=1`),
 * so the canvas behind the sidebar turns transparent and lets it through.
 */
export function markChromePlatform(root: HTMLElement = document.documentElement): ChromePlatform {
	const platform = chromePlatform();
	root.dataset.platform = platform;
	if (platform === "win32" && new URLSearchParams(window.location.search).get("mica") === "1") {
		root.dataset.mica = "true";
	}
	return platform;
}

/**
 * Windows only: push the caption-button colors whenever the theme or the
 * surface under the top-right corner changes (side panel docked → surface-1,
 * otherwise the canvas). Returns the cleanup.
 */
export function syncWindowControls(surfaceToken: "--sc-bg" | "--sc-surface-1"): () => void {
	if (chromePlatform() !== "win32" || typeof window.omp?.windowChrome?.setColors !== "function") return () => {};
	let last = "";
	const push = () => {
		const style = getComputedStyle(document.documentElement);
		const color = style.getPropertyValue(surfaceToken).trim();
		const symbolColor = style.getPropertyValue("--sc-text").trim();
		const key = `${color}|${symbolColor}`;
		if (!color || !symbolColor || key === last) return;
		last = key;
		window.omp.windowChrome.setColors({ color, symbolColor });
	};
	push();
	// Theme switches rewrite inline custom properties / classes on <html>.
	const observer = new MutationObserver(push);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
	const media = window.matchMedia?.("(prefers-color-scheme: dark)");
	media?.addEventListener("change", push);
	return () => {
		observer.disconnect();
		media?.removeEventListener("change", push);
	};
}
