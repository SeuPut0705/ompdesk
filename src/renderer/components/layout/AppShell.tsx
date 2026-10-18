/**
 * App shell (design-spec §2.1, §8):
 *
 *   Sidebar | main area | Side panel
 *
 * The main area shows either the open session (title bar, tabs, banners,
 * transcript + composer) or one of the three destination pages — Agents,
 * Insights, Settings — with the sidebar still visible. Esc on a page or
 * selecting a session returns to the session view; the session view stays
 * mounted underneath so its scroll position and composer survive.
 *
 * Responsive: the sidebar never folds on its own — it keeps its own width
 * (Sidebar's SIDEBAR_MIN floor) until the user collapses it. Below 1000px
 * only the side panel becomes a sheet over a scrim.
 */

import { ArrowLeft, Menu, PanelLeft, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCompactShell, useDrawerMode, useShellMode } from "../../hooks/use-shell-mode";
import { activeComposerInput } from "../../lib/composer-focus";
import { useT } from "../../lib/i18n";
import { whenIdle } from "../../lib/idle";
import { actionShortcut } from "../../lib/keymap";
import { markChromePlatform, syncWindowControls } from "../../lib/window-chrome";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { type PageDestination, useUiStore } from "../../stores/ui";
import { Button, IconButton, Spinner, Tooltip } from "../common";
import type { SettingsPage as LoadedSettingsPage } from "../settings/SettingsPage";
import { PanelContainer, preloadPanelViews } from "./PanelContainer";
import { EdgeSwipeZone, SidebarDrawer } from "./SidebarDrawer";
import { SplitWorkspace } from "./SplitWorkspace";
import { Sidebar } from "./sidebar/Sidebar";
import { TabHousekeeping } from "./TabHousekeeping";
import { TitleBar } from "./TitleBar";
import { UpdateBanner } from "./UpdateBanner";
import { WhatsNewCard } from "./WhatsNewCard";

const AgentsPage = lazy(() => import("../agents/AgentsPage").then(m => ({ default: m.AgentsPage })));
const InsightsPage = lazy(() => import("../insights/InsightsPage").then(m => ({ default: m.InsightsPage })));
const SettingsPage = lazy(() => import("../settings/SettingsPage").then(m => ({ default: m.SettingsPage })));
/** Settings from the idle-time preload in AppShell, once it has loaded. */
let preloadedSettingsPage: typeof LoadedSettingsPage | undefined;
/** How long a paired web page lets its first screen settle before the idle preloads start. */
const WEB_PRELOAD_DELAY_MS = 5000;

const PAGE_LABEL_KEY: Record<PageDestination, string> = {
	agents: "destination.agents",
	insights: "destination.insights",
	settings: "destination.settings",
};

/**
 * Settings, from the preloaded module when there is one. Through lazy() the
 * first open suspends even with the chunk already loaded, and React holds the
 * revealed page back behind the fallback for its Suspense throttle (~300 ms).
 * Picked once per mount, so a preload landing while the page is open never
 * remounts it.
 */
function SettingsDestination() {
	const [Page] = useState(() => preloadedSettingsPage ?? SettingsPage);
	return <Page />;
}

function DestinationPage({ destination }: { destination: PageDestination }): ReactNode {
	if (destination === "agents") return <AgentsPage />;
	if (destination === "insights") return <InsightsPage />;
	return <SettingsDestination />;
}

/** Thin bar above a destination page: window drag area, sidebar toggle, back to the session. */
function PageTopBar({ showSidebarToggle }: { showSidebarToggle: boolean }) {
	const t = useT();
	const toggleSidebar = useUiStore(s => s.toggleSidebar);
	const shellMode = useShellMode();
	const drawer = useDrawerMode();
	const closeDestination = useUiStore(s => s.closeDestination);
	// A phone keeps the page's own back control (MasterDetailBack) in this one row: the menu, the page's back
	// button and title in the slot, and the way out to the session as an icon at the right.
	if (shellMode === "phone")
		return (
			<div className="omp-topbar drag-region flex h-12 shrink-0 items-center gap-1 px-3">
				{showSidebarToggle && (
					<IconButton
						className="no-drag"
						icon={<Menu />}
						label={t("titlebar.toggleSidebar")}
						onClick={toggleSidebar}
						shortcut={actionShortcut("sidebar.toggle")}
					/>
				)}
				<div className="no-drag flex min-w-0 flex-1 items-center gap-1" data-page-topbar-slot />
				<IconButton
					className="no-drag"
					icon={<X />}
					label={t("shell.backToSession")}
					onClick={closeDestination}
					shortcut="⎋"
				/>
			</div>
		);
	return (
		<div className="omp-topbar drag-region flex h-12 shrink-0 items-center gap-1 px-3">
			{showSidebarToggle && (
				<IconButton
					className="no-drag"
					icon={drawer ? <Menu /> : <PanelLeft />}
					label={t("titlebar.toggleSidebar")}
					onClick={toggleSidebar}
					shortcut={actionShortcut("sidebar.toggle")}
				/>
			)}
			<Tooltip content={t("shell.backToSession")} describe={false} shortcut="⎋" side="bottom">
				<Button
					className="no-drag font-normal text-(--sc-text-secondary) hover:text-(--sc-text)"
					icon={<ArrowLeft />}
					onClick={closeDestination}
					size="sm"
					variant="ghost"
				>
					{t("shell.backToSession")}
				</Button>
			</Tooltip>
		</div>
	);
}

/**
 * Selecting a session (another tab, a switch in place, a new session) returns
 * from a destination page to the session view. A tab's first session arriving
 * (sessionId "" → id once get_state lands, after the sidecar reports ready) is
 * startup, not a selection: a page the user opened meanwhile stays open.
 * Returns the unsubscribe.
 */
export function leavePageOnSessionSelect(): () => void {
	const leave = () => {
		if (useUiStore.getState().destination !== "session") useUiStore.getState().closeDestination();
	};
	const unsubscribeTabs = useTabsStore.subscribe((next, previous) => {
		if (next.activeTabId !== previous.activeTabId) leave();
	});
	const unsubscribeSession = useSessionStore.subscribe((next, previous) => {
		if (previous.sessionId !== "" && next.sessionId !== previous.sessionId) leave();
	});
	return () => {
		unsubscribeTabs();
		unsubscribeSession();
	};
}

/**
 * Focus follows the main area. The session view is hidden, not unmounted, while
 * a page shows, so whatever had focus there (usually the composer) drops it at
 * once: until the page takes focus a frame later (a frame a hidden or occluded
 * window may not draw for seconds) a key would still reach the hidden composer,
 * whose Esc claims the keystroke the page's Esc needs. Opening a page lands
 * focus on the page itself, and going back returns it to where it was (else the
 * active pane's composer). Focus the user already moved elsewhere (a sidebar row,
 * a dialog) is left alone. Returns the unsubscribe.
 */
export function followPageFocus(page: () => HTMLElement | null): () => void {
	let returnTo: HTMLElement | null = null;
	let frame = 0;
	const unsubscribe = useUiStore.subscribe((next, previous) => {
		if (next.destination === previous.destination) return;
		if (previous.destination === "session") {
			const active = document.activeElement;
			returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
			if (returnTo?.closest("[data-session-view]")) returnTo.blur();
		}
		cancelAnimationFrame(frame);
		// After React commits the page (or reveals the session view again).
		frame = requestAnimationFrame(() => {
			const active = document.activeElement;
			const lost = !active || active === document.body;
			if (next.destination !== "session") {
				const section = page();
				if (section && (lost || !section.contains(active))) section.focus({ preventScroll: true });
				return;
			}
			const target = returnTo;
			returnTo = null;
			if (!lost) return;
			const back = target?.isConnected && target.getClientRects().length > 0 ? target : activeComposerInput();
			back?.focus();
		});
	});
	return () => {
		cancelAnimationFrame(frame);
		unsubscribe();
	};
}

/**
 * Phone and portrait tablet keep the session list in a drawer: `sidebarVisible` is its open state, so it starts
 * closed, and the docked state the window had comes back when the width does (a tablet turned to landscape).
 * Returns whether the store matches `drawer` yet: the drawer mounts only after the layout effect closed the
 * sidebar (still before paint), so it never opens for a frame, pushes a history entry and takes it back.
 */
function useDrawerSidebarSync(drawer: boolean): boolean {
	const docked = useRef<boolean | null>(null);
	const [syncedFor, setSyncedFor] = useState<boolean | null>(null);
	useLayoutEffect(() => {
		if (drawer) {
			if (docked.current === null) docked.current = useUiStore.getState().sidebarVisible;
			useUiStore.setState({ sidebarVisible: false });
		} else if (docked.current !== null) {
			useUiStore.setState({ sidebarVisible: docked.current });
			docked.current = null;
		}
		// A desktop window never synced anything: keep `null`, so its first render stays its only one.
		setSyncedFor(previous => (previous === null && !drawer ? null : drawer));
	}, [drawer]);
	return syncedFor === drawer;
}

export function AppShell() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const panelVisible = useUiStore(s => s.panelVisible);
	const panelSide = useUiStore(s => s.panelSide);
	// Keeps `html[data-shell]` and the keyboard, long-press and back-gesture listeners alive for the whole page.
	useShellMode();
	const drawer = useDrawerMode();
	const compact = useCompactShell();
	const drawerReady = useDrawerSidebarSync(drawer);
	const onPage = destination !== "session";
	const panelOpen = !onPage && panelVisible;
	const panelDocked = panelOpen && !compact;

	useLayoutEffect(() => {
		markChromePlatform();
	}, []);
	// Windows caption buttons sit over the top-right corner: match its surface.
	const panelAtRight = panelDocked && panelSide === "right";
	useEffect(() => syncWindowControls(panelAtRight ? "--sc-surface-1" : "--sc-bg"), [panelAtRight]);

	// Entering compact width: a docked side panel would turn into a modal sheet
	// the user never asked for, so close it.
	useEffect(() => {
		if (!compact) return;
		const ui = useUiStore.getState();
		if (ui.panelVisible) ui.togglePanel();
	}, [compact]);

	useEffect(leavePageOnSessionSelect, []);
	const pageRef = useRef<HTMLElement>(null);
	useEffect(() => followPageFocus(() => pageRef.current), []);
	// Settings opened ~300 ms after ⌘, (see SettingsDestination). Load its chunk
	// (~460 KB) in an idle moment after startup, so the first open renders it
	// directly; the same specifier as the lazy() above, so both resolve to one
	// module record. The side panel's views likewise (a web page has not loaded
	// them yet; the desktop already has, PanelContainer). A paired web page waits
	// WEB_PRELOAD_DELAY_MS first: its first screen idles while the socket answers,
	// and a preload in those gaps took the phone's link and CPU from it.
	useEffect(() => {
		let cancelIdle = () => {};
		const timer = setTimeout(
			() => {
				cancelIdle = whenIdle(() => {
					void import("../settings/SettingsPage").then(module => {
						preloadedSettingsPage = module.SettingsPage;
					});
					void preloadPanelViews();
				}, 10_000);
			},
			document.documentElement.dataset.platform === "web" ? WEB_PRELOAD_DELAY_MS : 0,
		);
		return () => {
			clearTimeout(timer);
			cancelIdle();
		};
	}, []);

	// Esc on a page goes back to the session, unless something on the page
	// (a search field, a menu) or an overlay already used the keystroke.
	useEffect(() => {
		if (!onPage) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			if (document.querySelector('[role="dialog"], [role="menu"]')) return;
			useUiStore.getState().closeDestination();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onPage]);

	return (
		<div className="omp-shell flex min-w-0 flex-1" data-sidebar={sidebarVisible && !drawer ? "docked" : "hidden"}>
			{drawer
				? drawerReady && (
						<>
							<SidebarDrawer />
							<EdgeSwipeZone />
						</>
					)
				: sidebarVisible && <Sidebar />}
			{panelOpen && panelSide === "left" && <PanelContainer />}

			<main aria-label={t("shell.main")} className="omp-workspace-main relative flex min-w-0 flex-1 flex-col">
				<div className={onPage ? "hidden" : "flex min-h-0 flex-1 flex-col"} data-session-view>
					<TitleBar />
					<TabHousekeeping />
					<UpdateBanner />
					<WhatsNewCard />
					<SplitWorkspace />
				</div>
				{onPage && (
					<section
						aria-label={t(PAGE_LABEL_KEY[destination])}
						className="flex min-h-0 flex-1 flex-col outline-none"
						data-destination={destination}
						ref={pageRef}
						tabIndex={-1}
					>
						<PageTopBar showSidebarToggle={!sidebarVisible} />
						<Suspense
							fallback={
								<div className="flex flex-1 items-center justify-center">
									<Spinner label={t("common.loading")} />
								</div>
							}
						>
							<DestinationPage destination={destination} />
						</Suspense>
					</section>
				)}
			</main>

			{panelOpen && panelSide === "right" && <PanelContainer />}
		</div>
	);
}
