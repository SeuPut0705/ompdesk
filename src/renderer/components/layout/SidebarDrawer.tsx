import { useEffect, useRef } from "react";
import { useBackLayer } from "../../hooks/use-back-layer";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { type TabsStore, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Sidebar } from "./sidebar/Sidebar";

/** A finger this far left of where it landed, mostly horizontal, closes the drawer. */
const CLOSE_SWIPE_PX = 72;
/** How far in from the edge a drag must travel to open the drawer, and how far off the line it may stray. */
const OPEN_SWIPE_PX = 56;
const SWIPE_SLOP_PX = 48;
/** A press that moves less than this is a tap, which the edge strip hands to what lies under it. */
const TAP_SLOP_PX = 10;

function closeDrawer(): void {
	useUiStore.setState({ sidebarVisible: false });
}

/**
 * Whether the window left the session it showed (the person picked another): the drawer closes then. The page settling
 * is not that: the first tab list naming the active tab (none before it) and a real tab taking over its ghost from the
 * last launch (`SessionTab.ghost`) both move `activeTabId` with no pick, and a tap on ☰ right after a phone page
 * loaded used to open the drawer and close it again at once.
 */
export function leftActiveSession(
	previous: Pick<TabsStore, "activeTabId" | "tabs">,
	next: Pick<TabsStore, "activeTabId">,
) {
	if (next.activeTabId === previous.activeTabId || previous.activeTabId === null) return false;
	return previous.tabs.find(tab => tab.id === previous.activeTabId)?.ghost !== true;
}

/**
 * The session list as a drawer: phone and portrait tablet (design §6.3). The docked `sidebarVisible` flag is
 * the drawer's open state, so ☰, the sidebar shortcut and the command palette all drive it as before. It closes
 * on whatever leaves the list behind (another session, a page), on the scrim, on Escape, on a swipe to the left
 * and on the system back gesture.
 */
export function SidebarDrawer() {
	const open = useUiStore(state => state.sidebarVisible);
	const { mounted, closing } = useOverlayPresence(open);
	const panelRef = useRef<HTMLDivElement>(null);
	useBackLayer(open, closeDrawer);

	useEffect(() => {
		if (!open) return;
		const unsubscribeTabs = useTabsStore.subscribe((next, previous) => {
			if (leftActiveSession(previous, next)) closeDrawer();
		});
		const unsubscribeUi = useUiStore.subscribe((next, previous) => {
			if (next.destination !== previous.destination) closeDrawer();
		});
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			if (document.querySelector('[role="dialog"]:not([data-drawer-panel]), [role="menu"]')) return;
			closeDrawer();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			unsubscribeTabs();
			unsubscribeUi();
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Swipe left on the panel to put it away.
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel || !open) return;
		let start: { id: number; x: number; y: number } | null = null;
		const down = (event: PointerEvent) => {
			start = event.pointerType === "touch" ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
		};
		const move = (event: PointerEvent) => {
			if (!start || event.pointerId !== start.id) return;
			const dx = event.clientX - start.x;
			const dy = event.clientY - start.y;
			if (dx < -CLOSE_SWIPE_PX && Math.abs(dy) < Math.abs(dx) / 2) {
				start = null;
				closeDrawer();
			}
		};
		const up = () => {
			start = null;
		};
		panel.addEventListener("pointerdown", down);
		panel.addEventListener("pointermove", move);
		panel.addEventListener("pointerup", up);
		panel.addEventListener("pointercancel", up);
		return () => {
			panel.removeEventListener("pointerdown", down);
			panel.removeEventListener("pointermove", move);
			panel.removeEventListener("pointerup", up);
			panel.removeEventListener("pointercancel", up);
		};
	}, [open]);

	if (!mounted) return null;
	return (
		<div
			className={`omp-drawer ${closing ? "omp-fade-out" : "omp-fade-in"}`}
			data-drawer=""
			data-sheet-placement="left"
			inert={closing}
			onMouseDown={event => {
				if (!closing && event.target === event.currentTarget) closeDrawer();
			}}
			role="presentation"
		>
			<div
				className={`omp-drawer-panel ${closing ? "omp-sheet-out" : "omp-sheet-in-left"}`}
				data-drawer-panel=""
				ref={panelRef}
			>
				<Sidebar />
			</div>
		</div>
	);
}

/**
 * A strip along the screen's left edge (touch only, mobile.css): dragging in from it opens the drawer. A drag
 * that goes mostly vertical is left alone. It is a real element, not a document listener, because the browser
 * takes a pan away from the page (pointercancel) while a touch-action strip keeps the pointer. The strip owns
 * swipes only: a tap on it is a tap on what lies under it, so a control at the screen's edge keeps the taps
 * its hit area reaches into the strip.
 */
export function EdgeSwipeZone() {
	const open = useUiStore(state => state.sidebarVisible);
	const start = useRef<{ id: number; x: number; y: number } | null>(null);
	if (open) return null;
	return (
		<div
			aria-hidden
			className="omp-edge-zone"
			data-edge-zone=""
			onPointerCancel={() => {
				start.current = null;
			}}
			onPointerDown={event => {
				if (event.pointerType !== "touch") return;
				start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				const from = start.current;
				if (!from || event.pointerId !== from.id) return;
				const dx = event.clientX - from.x;
				const dy = Math.abs(event.clientY - from.y);
				if (dy > SWIPE_SLOP_PX && dy > dx) start.current = null;
				else if (dx > OPEN_SWIPE_PX) {
					start.current = null;
					useUiStore.setState({ sidebarVisible: true });
				}
			}}
			onPointerUp={event => {
				const from = start.current;
				start.current = null;
				if (!from || event.pointerId !== from.id) return;
				if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP_PX) return;
				tapThrough(event.currentTarget, event.clientX, event.clientY);
			}}
		/>
	);
}

/** Hand a tap on the edge strip to the element under it, as if the strip were not there. */
function tapThrough(strip: Element, x: number, y: number): void {
	const below = document.elementsFromPoint(x, y).find(element => element !== strip);
	if (!(below instanceof HTMLElement || below instanceof SVGElement)) return;
	const field = below.closest<HTMLElement>("input, textarea, select, [contenteditable='true']");
	if (field) field.focus();
	else below.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}
