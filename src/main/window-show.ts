/**
 * Showing a window created with `show: false`. `ready-to-show` alone is not enough on Windows: a hidden window
 * with `titleBarOverlay` never emits it when its first frame is slow (the app's stylesheets make it so), and the
 * window stayed invisible for good (electron/electron#54025; reproduced on Electron 36.9.5, where a resize or a
 * show is what lets the first frame through). The page having loaded is the fallback: a hidden window's renderer
 * has laid out the boot shell by then, and showing it starts the frames.
 */
interface Emitter {
	once(event: string, listener: () => void): unknown;
}

export function showOnFirstPaint(win: Emitter, contents: Emitter, show: () => void): void {
	let shown = false;
	const once = () => {
		if (shown) return;
		shown = true;
		show();
	};
	win.once("ready-to-show", once);
	contents.once("did-finish-load", once);
}
