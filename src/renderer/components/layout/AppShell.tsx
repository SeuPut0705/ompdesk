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
 * Responsive: ≥ 1280px full sidebar; 1000–1279px the sidebar folds to an
 * icon rail while the side panel is open; < 1000px the sidebar and the side
 * panel become sheets (left / right) over a scrim.
 */

import { ArrowLeft, PanelLeft } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { useMediaQuery } from "../../hooks/use-media-query";
import { useT } from "../../lib/i18n";
import { actionShortcut } from "../../lib/keymap";
import { markChromePlatform, syncWindowControls } from "../../lib/window-chrome";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { COMPACT_SHELL_QUERY, type PageDestination, useUiStore } from "../../stores/ui";
import { Button, IconButton, Sheet, Spinner } from "../common";
import { PanelContainer } from "./PanelContainer";
import { Sidebar, type SidebarVariant } from "./Sidebar";
import { SidecarBanner } from "./SidecarBanner";
import { SplitWorkspace } from "./SplitWorkspace";
import { TabBar } from "./TabBar";
import { TitleBar } from "./TitleBar";
import { UpdateBanner } from "./UpdateBanner";

const AgentsPage = lazy(() => import("../agents/AgentsPage").then(m => ({ default: m.AgentsPage })));
const InsightsPage = lazy(() => import("../insights/InsightsPage").then(m => ({ default: m.InsightsPage })));
const SettingsPage = lazy(() => import("../settings/SettingsPage").then(m => ({ default: m.SettingsPage })));

/** Below this the sidebar folds to a rail while the side panel is docked. */
const RAIL_QUERY = "(max-width: 1279px)";

const PAGE_LABEL_KEY: Record<PageDestination, string> = {
	agents: "destination.agents",
	insights: "destination.insights",
	settings: "destination.settings",
};

function DestinationPage({ destination }: { destination: PageDestination }): ReactNode {
	if (destination === "agents") return <AgentsPage />;
	if (destination === "insights") return <InsightsPage />;
	return <SettingsPage />;
}

/** Thin bar above a destination page: window drag area, sidebar toggle, back to the session. */
function PageTopBar({ showSidebarToggle }: { showSidebarToggle: boolean }) {
	const t = useT();
	const toggleSidebar = useUiStore(s => s.toggleSidebar);
	const closeDestination = useUiStore(s => s.closeDestination);
	return (
		<div className="omp-topbar drag-region flex h-12 shrink-0 items-center gap-1 px-2">
			{showSidebarToggle && (
				<IconButton
					className="no-drag"
					icon={<PanelLeft />}
					label={t("titlebar.toggleSidebar")}
					onClick={toggleSidebar}
					shortcut={actionShortcut("sidebar.toggle")}
				/>
			)}
			<Button className="no-drag" icon={<ArrowLeft />} onClick={closeDestination} size="sm" variant="ghost">
				{t("shell.backToSession")}
			</Button>
		</div>
	);
}

export function AppShell() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const compactSidebarOpen = useUiStore(s => s.compactSidebarOpen);
	const closeCompactSidebar = useUiStore(s => s.closeCompactSidebar);
	const panelVisible = useUiStore(s => s.panelVisible);
	const compact = useMediaQuery(COMPACT_SHELL_QUERY);
	const narrow = useMediaQuery(RAIL_QUERY);
	const [railExpanded, setRailExpanded] = useState(false);
	const onPage = destination !== "session";
	const panelOpen = !onPage && panelVisible;
	const panelDocked = panelOpen && !compact;

	const sidebar: SidebarVariant | "hidden" = compact
		? "hidden"
		: !sidebarVisible
			? "hidden"
			: panelDocked && narrow && !railExpanded
				? "rail"
				: "docked";

	useLayoutEffect(() => {
		markChromePlatform();
	}, []);
	// Windows caption buttons sit over the top-right corner: match its surface.
	useEffect(() => syncWindowControls(panelDocked ? "--sc-surface-1" : "--sc-bg"), [panelDocked]);
	// The rail override lasts only while the side panel that caused it is open.
	useEffect(() => {
		if (!panelDocked) setRailExpanded(false);
	}, [panelDocked]);

	// Entering compact width: a docked side panel would turn into a modal sheet
	// the user never asked for, so close it; the left sheet starts closed too.
	useEffect(() => {
		if (!compact) {
			closeCompactSidebar();
			return;
		}
		const ui = useUiStore.getState();
		if (ui.panelVisible) ui.togglePanel();
	}, [compact, closeCompactSidebar]);

	// Selecting a session (another tab, a switch in place, a new session)
	// returns from a destination page to the session view.
	useEffect(() => {
		const leave = () => {
			if (useUiStore.getState().destination !== "session") useUiStore.getState().closeDestination();
		};
		const unsubscribeTabs = useTabsStore.subscribe((next, previous) => {
			if (next.activeTabId !== previous.activeTabId) leave();
		});
		const unsubscribeSession = useSessionStore.subscribe((next, previous) => {
			if (previous.sessionId !== null && next.sessionId !== previous.sessionId) leave();
		});
		return () => {
			unsubscribeTabs();
			unsubscribeSession();
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
		<div className="omp-shell flex min-w-0 flex-1" data-sidebar={sidebar}>
			{sidebar !== "hidden" && <Sidebar onExpandRail={() => setRailExpanded(true)} variant={sidebar} />}
			{compact && (
				<Sheet
					bodyClassName="flex flex-col"
					onClose={closeCompactSidebar}
					open={compactSidebarOpen}
					side="left"
					size="sm"
					title={t("sidebar.sheetTitle")}
				>
					<Sidebar variant="sheet" />
				</Sheet>
			)}

			<main aria-label={t("shell.main")} className="omp-workspace-main relative flex min-w-0 flex-1 flex-col">
				<div className={onPage ? "hidden" : "flex min-h-0 flex-1 flex-col"} data-session-view>
					<TitleBar />
					<TabBar />
					<SidecarBanner />
					<UpdateBanner />
					<SplitWorkspace />
				</div>
				{onPage && (
					<section
						aria-label={t(PAGE_LABEL_KEY[destination])}
						className="flex min-h-0 flex-1 flex-col"
						data-destination={destination}
					>
						<PageTopBar showSidebarToggle={sidebar === "hidden"} />
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

			{panelOpen && <PanelContainer />}
		</div>
	);
}
