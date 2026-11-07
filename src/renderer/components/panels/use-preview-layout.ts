import { type RefObject, useEffect } from "react";
import type { PreviewRequest } from "../../../shared/preview";

/** The page's own ids of a dialog or menu that a native preview view floats under, so it must hide while one is open. */
const OVERLAYS =
	'.omp-dialog-overlay, [role="dialog"], [role="alertdialog"], [role="menu"], [data-state="open"][data-popover]';

/**
 * Tells the host where the preview surface is, so it can place the native view (desktop) or size the offscreen page
 * it streams (a phone). `shown` is whether the page may be seen at all.
 */
export function usePreviewLayout(
	surface: RefObject<HTMLElement | null>,
	web: boolean,
	shown: boolean,
	command: (request: PreviewRequest) => void,
) {
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		let frame = 0;
		let lastLayout = "";
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const bounds = element.getBoundingClientRect();
				// A native view floats over the window, so a dialog or menu above it must hide it. A web viewer's
				// frame is an ordinary image in the page (and the panel itself is a sheet there): nothing covers it.
				const covered =
					!web && [...document.querySelectorAll(OVERLAYS)].some(node => node.getClientRects().length > 0);
				const request: PreviewRequest = {
					action: "layout",
					// The streamed page sizes to the surface alone: where it sits in the window means nothing to the host.
					bounds: web
						? { x: 0, y: 0, width: Math.round(bounds.width), height: Math.round(bounds.height) }
						: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
					visible: shown && !covered,
					// A web viewer's page is rendered for its own screen density; an Electron window sends none.
					...(web ? { dpr: window.devicePixelRatio } : {}),
				};
				const key = JSON.stringify(request);
				if (web && key === lastLayout) return;
				lastLayout = key;
				command(request);
			});
		};
		const resize = new ResizeObserver(update);
		resize.observe(element);
		const mutations = new MutationObserver(update);
		// Only a native view needs to follow dialogs opening over it.
		if (!web) {
			mutations.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["aria-hidden", "data-state", "style"],
			});
		}
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		update();
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [surface, web, shown, command]);
	// Only the panel going away hides the page. Doing it in the effect above sent a zero-size layout on every re-run
	// and the real one a frame later, so a phone's offscreen page shrank to 1x1 whenever the address changed.
	useEffect(
		() => () => command({ action: "layout", bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }),
		[command],
	);
}
