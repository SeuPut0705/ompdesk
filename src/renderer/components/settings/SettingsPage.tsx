/**
 * Settings — a destination page in the main area (design-spec §2, §3). A
 * flat left sub-nav (always fully visible), one search field, and the
 * selected section. Curated sections come first in plain language; the full
 * agent schema stays reachable under Advanced. The shell owns Esc/back.
 *
 * Routing: `useUiStore.settingsTab` holds `section[:sub]`
 * (`resolveSettingsTarget`); `openSettings(target)` deep-links from
 * anywhere, `setSettingsSection` navigates within the page.
 *
 * A focused tab on a paired host shows that host's agent settings: a banner
 * names the host, app-scoped sections carry a "This device" tag, and host
 * sections show an offline notice while the host is unreachable
 * (`SECTION_SCOPE`, components/remote/HostScope.tsx).
 */

import {
	Blocks,
	Bot,
	CalendarClock,
	FolderOpen,
	HardDriveDownload,
	Keyboard,
	type LucideIcon,
	MonitorSmartphone,
	Palette,
	RefreshCw,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SettingEntry, SidecarStatus } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/keymap";
import { type FocusedHost, useFocusedHost } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, EmptyState, ListRow, SearchField } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { HostScoped, ThisDeviceTag } from "../remote/HostScope";
import { AgentSection } from "./AgentSection";
import { AgentWorktreesRows } from "./AgentWorktreesRow";
import { AppearanceSection } from "./AppearanceSection";
import { ExtensionsSection } from "./ExtensionsSection";
import { GeneralSection } from "./GeneralSection";
import { KeyboardSection } from "./KeyboardSection";
import { LaunchProfileSection } from "./LaunchSettings";
import { MachineSetupSection } from "./MachineSetupSection";
import { ModelsSection } from "./ModelsSection";
import { OtherExtensionIds } from "./OtherExtensionIds";
import { AdvancedSchemaSettings, OwnedSchemaSettings } from "./OwnedSchemaSettings";
import { PermissionsSection } from "./PermissionsSection";
import { PluginsSection } from "./PluginsSection";
import { RemoteSection } from "./RemoteSection";
import { SchedulesSection } from "./SchedulesSection";
import { SettingsScopeProvider, SettingsSection } from "./SettingsLayout";
import { SshSection } from "./SshSection";
import { schemaSettingText } from "./schema-i18n";
import {
	CUSTOM_SCHEMA_EDITORS,
	EXTENSIONS_TABS,
	type ExtensionsTab,
	GUI_SEARCH_ITEMS,
	PLUGINS_TABS,
	type PluginsTab,
	resolveSettingsTarget,
	SECTION_SCOPE,
	SETTINGS_NAV,
	type SettingsSectionId,
} from "./settings-catalog";
import { SettingsDataProvider, useSettingsDataLoader } from "./settings-data";
import { SettingsNavigationProvider } from "./settings-navigation";
import { searchSettings } from "./settings-search";
import { UpdatesSection } from "./UpdatesSection";
import { WorkspaceSection } from "./WorkspaceSection";
import { WorktreeBranchPrefixRow } from "./WorktreeBranchPrefixRow";

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
	general: SlidersHorizontal,
	appearance: Palette,
	keyboard: Keyboard,
	models: Bot,
	permissions: ShieldCheck,
	agent: Sparkles,
	tools: Blocks,
	workspace: FolderOpen,
	schedules: CalendarClock,
	connections: MonitorSmartphone,
	updates: HardDriveDownload,
	advanced: Wrench,
};

/** Sections whose content comes from the agent: they explain a missing omp connection. */
const AGENT_SECTIONS: Partial<Record<SettingsSectionId, true>> = {
	agent: true,
	models: true,
	permissions: true,
	tools: true,
	advanced: true,
};

/** List sections filter their own rows with the page search instead of showing global results; value = its placeholder key. */
const LIST_SECTIONS: Partial<Record<SettingsSectionId, string>> = { keyboard: "settings.search.shortcuts" };

export function SettingsConnectionBanner({
	status,
	error,
	busy,
	onRetry,
}: {
	status: SidecarStatus;
	error: string | null;
	busy: boolean;
	onRetry: () => void;
}) {
	const t = useT();
	const waiting = status === "starting" || status === "restarting";
	return (
		<Banner
			actions={
				waiting ? undefined : (
					<Button disabled={busy} icon={<RefreshCw />} onClick={onRetry} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				)
			}
			live
			title={t(waiting ? "settings.connection.connecting" : "settings.connection.unavailable")}
			variant={waiting ? "info" : "warning"}
		>
			<span data-settings-connection-notice="true">
				{error ?? t(waiting ? "settings.connection.waiting" : "settings.connection.retryHint")}
			</span>
		</Banner>
	);
}

/** The focused tab runs on a paired host: name it, and say app settings stay this device's. */
export function SettingsDeviceBanner({ host }: { host: FocusedHost }) {
	const t = useT();
	const name = host.name ?? t("remote.tab.unknownDevice");
	return (
		<div data-settings-device-banner={host.deviceId}>
			<Banner actions={<DeviceChip deviceId={host.deviceId} />} className="mb-5">
				{t("settings.device.banner", { name })}
			</Banner>
		</div>
	);
}

export function SettingsPage() {
	const t = useT();
	const { lang } = useLang();
	const data = useSettingsDataLoader();
	const settingsTab = useUiStore(state => state.settingsTab);
	const sidecarStatus = useSessionStore(state => state.status);
	const sidecarError = useSessionStore(state => state.sidecarError);
	const { section, sub } = resolveSettingsTarget(settingsTab);
	const host = useFocusedHost();
	// An unreachable host's sections show its offline notice instead of the connection banners.
	const hostOffline = host !== undefined && !host.online;
	const agentSection = AGENT_SECTIONS[section] === true && !hostOffline;
	const [query, setQuery] = useState("");
	const [focusRowId, setFocusRowId] = useState<string | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const navigate = useCallback((target: string, rowId?: string) => {
		useUiStore.getState().setSettingsSection(target);
		setQuery("");
		setFocusRowId(rowId ?? null);
	}, []);

	// The search waits for ⌘F (Ctrl+F) rather than grabbing focus on open: an
	// autofocused field greeted every visit, mouse ones included, with a lit
	// focus ring. `code`, not `key`: a Korean layout reports ⌘ㄹ.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.code !== "KeyF" || event.altKey || event.shiftKey || event.isComposing) return;
			const mod = PLATFORM === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (!mod || document.querySelector('[role="dialog"]')) return;
			event.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Each section starts at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a section change resets the scroll container.
	useLayoutEffect(() => {
		if (contentRef.current) contentRef.current.scrollTop = 0;
	}, [section]);

	// Deep links and search results scroll to their row once it has rendered (schema rows arrive after load).
	// A `sub` that starts with `setting-` names a row id outright (`models:setting-providers.webSearch`).
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadState re-runs the lookup when schema rows mount.
	useEffect(() => {
		const id =
			focusRowId ??
			(sub
				? sub.startsWith("setting-")
					? sub
					: (GUI_SEARCH_ITEMS.find(item => item.section === section && item.sub === sub)?.rowId ??
						Object.values(CUSTOM_SCHEMA_EDITORS).find(editor => editor.section === section && editor.sub === sub)
							?.rowId ??
						(section === "tools"
							? `settings-tools-${PLUGINS_TABS.includes(sub as PluginsTab) ? "plugins" : "extensions"}`
							: `settings-${section}-${sub}`))
				: null);
		if (!id || query) return;
		const frame = requestAnimationFrame(() => {
			const target = document.getElementById(id);
			if (!target) return;
			// A row folded under Advanced: open its disclosure first, or the scroll lands on nothing.
			for (let node = target.parentElement; node; node = node.parentElement)
				if (node.tagName === "DETAILS") node.setAttribute("open", "");
			target.scrollIntoView({ block: focusRowId ? "center" : "start" });
			if (focusRowId) {
				// The focus lands a frame later; if the user already started typing
				// somewhere (a new search), taking focus would send their keystrokes
				// into this row's field instead.
				const active = document.activeElement;
				const typingElsewhere =
					active instanceof HTMLElement &&
					!target.contains(active) &&
					active.matches("input, textarea, select, [contenteditable='true']");
				if (!typingElsewhere) {
					target
						.querySelector<HTMLElement>("button:not([disabled]), input, select, textarea, [tabindex='0']")
						?.focus({ preventScroll: true });
				}
				target.animate?.([{ backgroundColor: "var(--sc-selected)" }, { backgroundColor: "transparent" }], {
					duration: 1600,
				});
				setFocusRowId(null);
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [focusRowId, section, sub, query, data.loadState]);

	const listPlaceholder = LIST_SECTIONS[section];
	const listSection = listPlaceholder !== undefined;
	const results = useMemo(() => {
		if (!query.trim() || listSection) return null;
		const tabs = data.schema?.tabs ?? [];
		return searchSettings({
			query,
			t,
			entries: data.sidecarReady ? (data.schema?.entries ?? []) : [],
			values: data.values,
			schemaTabLabel: tabId => {
				const key = `settings.tabs.${tabId}`;
				const translated = t(key);
				return translated === key ? (tabs.find(tab => tab.id === tabId)?.label ?? tabId) : translated;
			},
			schemaLabel: (entry: SettingEntry) => schemaSettingText(lang, entry.path)?.label ?? entry.label ?? entry.path,
		});
	}, [query, listSection, data.schema, data.sidecarReady, data.values, lang, t]);

	const sectionTitle = t(`settings.section.${section}`);
	const extensionsTab: ExtensionsTab = (EXTENSIONS_TABS as readonly string[]).includes(sub ?? "")
		? (sub as ExtensionsTab)
		: "skills";
	const pluginsTab: PluginsTab = (PLUGINS_TABS as readonly string[]).includes(sub ?? "")
		? (sub as PluginsTab)
		: "plugins";

	const renderSection = () => {
		switch (section) {
			case "general":
				return <GeneralSection />;
			case "appearance":
				return <AppearanceSection />;
			case "keyboard":
				return <KeyboardSection query={query} />;
			case "models":
				return <ModelsSection sub={sub} />;
			case "permissions":
				return (
					<>
						<PermissionsSection />
						<AdvancedSchemaSettings section="permissions" />
					</>
				);
			case "agent":
				return <AgentSection />;
			case "tools":
				// Skills, MCP and plugins first; the stock tool knobs fold under Advanced.
				return (
					<>
						<SettingsSection id="settings-tools-extensions" title={t("settings.section.extensions")}>
							<ExtensionsSection
								onTabChange={tab => navigate(`tools:${tab}`)}
								query={query}
								tab={extensionsTab}
							/>
							<OtherExtensionIds />
						</SettingsSection>
						<SettingsSection id="settings-tools-plugins" title={t("settings.section.plugins")}>
							<PluginsSection onTabChange={tab => navigate(`tools:${tab}`)} query={query} tab={pluginsTab} />
						</SettingsSection>
						<AdvancedSchemaSettings
							id="settings-tools-tools"
							section="tools"
							title={t("settings.features.tools")}
						/>
					</>
				);
			case "workspace":
				return (
					<>
						<WorkspaceSection />
						<SettingsSection id="settings-workspace-worktrees" scope="app" title={t("settings.worktrees")}>
							<WorktreeBranchPrefixRow />
							<AgentWorktreesRows />
						</SettingsSection>
						<AdvancedSchemaSettings section="workspace">
							<LaunchProfileSection />
						</AdvancedSchemaSettings>
					</>
				);
			case "schedules":
				return <SchedulesSection />;
			case "connections":
				return (
					<>
						<SettingsSection
							scope="app"
							id="settings-connections-remote"
							title={t("settings.connections.sharing")}
						>
							<RemoteSection />
						</SettingsSection>
						<HostScoped>
							<SettingsSection scope="host" id="settings-connections-ssh" title={t("settings.section.ssh")}>
								<SshSection />
							</SettingsSection>
						</HostScoped>
					</>
				);
			case "updates":
				return (
					<>
						<UpdatesSection />
						<MachineSetupSection />
						<HostScoped>
							<AdvancedSchemaSettings scope="host" section="updates" />
						</HostScoped>
					</>
				);
			case "advanced":
				return <OwnedSchemaSettings section="advanced" />;
		}
	};

	return (
		<SettingsDataProvider value={data}>
			<SettingsNavigationProvider value={navigate}>
				<div className="settings-root h-full min-h-0 w-full">
					<div
						className="settings-page flex h-full min-h-0 w-full bg-(--sc-bg) text-(--sc-text)"
						data-settings-page="true"
					>
						<nav
							aria-labelledby="settings-page-title"
							className="settings-nav flex shrink-0 flex-col gap-3 overflow-y-auto border-r border-(--sc-divider) px-3 pt-6 pb-5"
						>
							<h1
								className="px-2 text-sc-xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)"
								id="settings-page-title"
							>
								{t("settings.title")}
							</h1>
							<SearchField
								label={t("settings.searchPlaceholder")}
								onValueChange={setQuery}
								placeholder={listPlaceholder ? t(listPlaceholder) : t("settings.searchPlaceholder")}
								ref={searchRef}
								shortcut="⌘F"
								spellCheck={false}
								value={query}
							/>
							{SETTINGS_NAV.map(group => (
								<div key={group.id} role="group" aria-labelledby={`settings-nav-${group.id}`}>
									<div
										className="px-2.5 pt-2 pb-1 text-sc-xs font-medium text-(--sc-text-muted)"
										id={`settings-nav-${group.id}`}
									>
										{t(`settings.navHeading.${group.id}`)}
									</div>
									{group.items.map(id => {
										const Icon = SECTION_ICONS[id];
										return (
											<ListRow
												buttonProps={{ "data-settings-section": id }}
												key={id}
												leading={<Icon aria-hidden />}
												meta={SECTION_SCOPE[id] === "app" ? <ThisDeviceTag compact /> : undefined}
												onClick={() => navigate(id)}
												// Search results replace the section: no row claims the page meanwhile.
												selected={results === null && id === section}
												title={t(`settings.section.${id}`)}
												rowProps={{ "data-settings-nav": id, "data-settings-scope": SECTION_SCOPE[id] }}
											/>
										);
									})}
								</div>
							))}
						</nav>
						<div className="settings-content min-h-0 min-w-0 flex-1 overflow-y-auto" ref={contentRef}>
							<section aria-labelledby="settings-section-title" className="settings-column">
								{host && <SettingsDeviceBanner host={host} />}
								<header className="mb-6">
									<h2
										className="text-sc-2xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)"
										id="settings-section-title"
									>
										{results ? t("settings.search.title") : sectionTitle}
									</h2>
									<p className="mt-1 text-sc-sm break-keep text-(--sc-text-muted)">
										{results
											? t("settings.search.count", { count: results.length })
											: t(`settings.section.${section}.desc`)}
									</p>
									{/* Whose settings these are only matters while the focused tab runs on a paired host. */}
									{!results && host && (
										<p
											className="mt-2 text-sc-xs text-(--sc-text-muted)"
											data-settings-section-scope={SECTION_SCOPE[section]}
										>
											{SECTION_SCOPE[section] === "app" ? (
												<ThisDeviceTag />
											) : (
												<>
													{t(
														`settings.navGroup.${SECTION_SCOPE[section] === "host" ? "agent" : "system"}`,
													)}
													{SECTION_SCOPE[section] === "host" && host.name ? `: ${host.name}` : ""}
												</>
											)}
										</p>
									)}
								</header>
								{agentSection && !data.sidecarReady && (
									<SettingsConnectionBanner
										busy={data.sidecarBusy}
										error={sidecarError}
										onRetry={data.retry}
										status={sidecarStatus}
									/>
								)}
								{agentSection && data.sidecarReady && data.loadState === "error" && (
									<Banner
										actions={
											<Button icon={<RefreshCw />} onClick={data.retry} size="sm" variant="secondary">
												{t("common.retry")}
											</Button>
										}
										live
										title={t("settings.schemaLoadFailed")}
										variant="danger"
									>
										{data.loadError ?? t("settings.schemaUnavailable")}
									</Banner>
								)}
								{results ? (
									results.length === 0 ? (
										<EmptyState
											description={t("settings.search.emptyDesc")}
											title={t("settings.noMatches")}
										/>
									) : (
										<div className="flex flex-col gap-0.5" data-settings-search-results="true">
											{results.map(result => (
												<ListRow
													description={
														result.path ? `${result.location} · ${result.path}` : result.location
													}
													key={result.key}
													onClick={() => navigate(result.target, result.rowId)}
													rowProps={{ "data-search-key": result.key, "data-search-path": result.path }}
													title={result.title}
												/>
											))}
										</div>
									)
								) : (
									<div className="settings-sections">
										{listSection && query.trim() !== "" && (
											<div className="mb-4">
												<Button
													onClick={() => useUiStore.getState().setSettingsSection("general")}
													size="sm"
													variant="ghost"
												>
													{t("settings.search.everywhere", { query: query.trim() })}
												</Button>
											</div>
										)}
										<SettingsScopeProvider value={SECTION_SCOPE[section]}>
											{SECTION_SCOPE[section] === "host" ? (
												<HostScoped>{renderSection()}</HostScoped>
											) : (
												renderSection()
											)}
										</SettingsScopeProvider>
									</div>
								)}
							</section>
						</div>
					</div>
				</div>
			</SettingsNavigationProvider>
		</SettingsDataProvider>
	);
}
