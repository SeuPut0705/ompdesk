/**
 * The session list is a chunk of its own (components/layout/sidebar-chunk.ts): a phone's first screen never draws
 * it. Where the list is docked (a landscape or wide portrait tablet) the first render waits for it, so the page asks
 * for its files beside the app's rather than after the app has run: `web.html` names them in a `<meta>` (written at
 * build time by scripts/pwa-plugin.ts, which also precaches them), and the boot adds a preload for each. Not an
 * `import()` here: one from the entry chunk made Rollup split everything the list shares with the app into chunks of
 * their own, four more requests on every phone.
 */

export const SESSION_LIST_META = "omp-session-list";

/** Preload the session list's files named in `doc`'s `<meta>`. */
export function preloadSessionList(doc: Document): void {
	const files = doc.querySelector<HTMLMetaElement>(`meta[name="${SESSION_LIST_META}"]`)?.content.split(" ") ?? [];
	for (const href of files) {
		if (!href) continue;
		const link = doc.createElement("link");
		// As Vite's preload helper asks for them, so the later import() and stylesheet take these responses.
		if (href.endsWith(".css")) {
			link.rel = "preload";
			link.as = "style";
		} else link.rel = "modulepreload";
		link.crossOrigin = "";
		link.href = href;
		doc.head.append(link);
	}
}
