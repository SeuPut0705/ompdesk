/**
 * Settings — a destination page in the main area (design-spec §2, §3). A
 * flat left sub-nav (always fully visible), one search field, and the
 * selected section. Curated sections come first in plain language; the full
 * agent schema stays reachable under Advanced. The shell owns Esc/back.
 *
 * Routing: `useUiStore.settingsTab` holds `section[:sub]`
 * (`resolveSettingsTarget`); `openSettings(target)` deep-links from
 * anywhere, `setSettingsSection` navigates within the page.
 */

import {
	Blocks,
	Bot,
	FolderOpen,
	HardDriveDownload,
	Keyboard,
	type LucideIcon,
	Package,
	Palette,
	RefreshCw,
	Server,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SettingEntry, SidecarStatus } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, EmptyState, ListRow, SearchField } from "../common";
import { AdvancedSection } from "./AdvancedSection";
import { AppearanceSection } from "./AppearanceSection";
import { ExtensionsSection } from "./ExtensionsSection";
import { FeaturesSection } from "./FeaturesSection";
import { GeneralSection } from "./GeneralSection";
import { KeyboardSection } from "./KeyboardSection";
import { ModelsSection } from "./ModelsSection";
import { PermissionsSection } from "./PermissionsSection";
import { PluginsSection } from "./PluginsSection";
import { SshSection } from "./SshSection";
import { schemaSettingText } from "./schema-i18n";
import {
	EXTENSIONS_TABS,
	type ExtensionsTab,
	PLUGINS_TABS,
	type PluginsTab,
	resolveSettingsTarget,
	SETTINGS_NAV,
	type SettingsSectionId,
} from "./settings-catalog";
import { SettingsDataProvider, useSettingsDataLoader } from "./settings-data";
import { SettingsNavigationProvider } from "./settings-navigation";
import { searchSettings } from "./settings-search";
import { UpdatesSection } from "./UpdatesSection";
import { WorkspaceSection } from "./WorkspaceSection";

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
	general: SlidersHorizontal,
	appearance: Palette,
	keyboard: Keyboard,
	models: Bot,
	permissions: ShieldCheck,
	features: Sparkles,
	extensions: Blocks,
	plugins: Package,
	workspace: FolderOpen,
	ssh: Server,
	updates: HardDriveDownload,
	advanced: Wrench,
};

/** Sections whose content comes from the agent: they explain a missing omp connection. */
const AGENT_SECTIONS: Partial<Record<SettingsSectionId, true>> = {
	general: true,
	models: true,
	permissions: true,
	features: true,
	advanced: true,
};

/** List sections filter their own rows with the page search instead of showing global results. */
const LIST_SECTIONS: Partial<Record<SettingsSectionId, true>> = { keyboard: true, extensions: true, plugins: true };

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

export function SettingsPage() {
	const t = useT();
	const { lang } = useLang();
	const data = useSettingsDataLoader();
	const settingsTab = useUiStore(state => state.settingsTab);
	const sidecarStatus = useSessionStore(state => state.status);
	const sidecarError = useUiStore(state => state.sidecarError);
	const { section, sub } = resolveSettingsTarget(settingsTab);
	const [query, setQuery] = useState("");
	const [focusRowId, setFocusRowId] = useState<string | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const navigate = useCallback((target: string, rowId?: string) => {
		useUiStore.getState().setSettingsSection(target);
		setQuery("");
		setFocusRowId(rowId ?? null);
	}, []);

	// Keyboard-first: the page opens with the search field focused.
	useEffect(() => {
		searchRef.current?.focus({ preventScroll: true });
	}, []);

	// Each section starts at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a section change resets the scroll container.
	useLayoutEffect(() => {
		if (contentRef.current) contentRef.current.scrollTop = 0;
	}, [section]);

	// Deep links and search results scroll to their row once it has rendered (schema rows arrive after load).
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadState re-runs the lookup when schema rows mount.
	useEffect(() => {
		const id = focusRowId ?? (section === "models" && sub ? `settings-models-${sub}` : null);
		if (!id || query) return;
		const frame = requestAnimationFrame(() => {
			const target = document.getElementById(id);
			if (!target) return;
			target.scrollIntoView({ block: focusRowId ? "center" : "start" });
			if (focusRowId) {
				target
					.querySelector<HTMLElement>("button:not([disabled]), input, select, textarea, [tabindex='0']")
					?.focus({ preventScroll: true });
				target.animate?.([{ backgroundColor: "var(--sc-selected)" }, { backgroundColor: "transparent" }], {
					duration: 1600,
				});
				setFocusRowId(null);
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [focusRowId, section, sub, query, data.loadState]);

	const listSection = LIST_SECTIONS[section] === true;
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
				return <ModelsSection />;
			case "permissions":
				return <PermissionsSection />;
			case "features":
				return <FeaturesSection />;
			case "extensions":
				return (
					<ExtensionsSection
						onTabChange={tab => navigate(`extensions:${tab}`)}
						query={query}
						tab={extensionsTab}
					/>
				);
			case "plugins":
				return <PluginsSection onTabChange={tab => navigate(`plugins:${tab}`)} query={query} tab={pluginsTab} />;
			case "workspace":
				return <WorkspaceSection />;
			case "ssh":
				return <SshSection />;
			case "updates":
				return <UpdatesSection />;
			case "advanced":
				return <AdvancedSection category={sub} onCategoryChange={category => navigate(`advanced:${category}`)} />;
		}
	};

	return (
		<SettingsDataProvider value={data}>
			<SettingsNavigationProvider value={navigate}>
				<div
					className="settings-page flex h-full min-h-0 w-full bg-(--sc-bg) text-(--sc-text)"
					data-settings-page="true"
				>
					<nav
						aria-labelledby="settings-page-title"
						className="settings-nav flex shrink-0 flex-col gap-3 overflow-y-auto border-r border-(--sc-divider) px-3 py-5"
					>
						<h1 className="px-2 text-sc-xl font-semibold text-(--sc-text)" id="settings-page-title">
							{t("settings.title")}
						</h1>
						<SearchField
							label={t("settings.searchPlaceholder")}
							onValueChange={setQuery}
							placeholder={
								listSection
									? t("settings.search.inSection", { section: sectionTitle })
									: t("settings.searchPlaceholder")
							}
							ref={searchRef}
							spellCheck={false}
							value={query}
						/>
						{SETTINGS_NAV.map(group => (
							<div key={group.id} role="group" aria-labelledby={`settings-nav-${group.id}`}>
								<div
									className="px-2.5 pt-2 pb-1 text-sc-xs font-medium text-(--sc-text-muted)"
									id={`settings-nav-${group.id}`}
								>
									{t(`settings.navGroup.${group.id}`)}
								</div>
								{group.items.map(id => {
									const Icon = SECTION_ICONS[id];
									return (
										<ListRow
											buttonProps={{ "data-settings-section": id }}
											key={id}
											leading={<Icon aria-hidden />}
											onClick={() => navigate(id)}
											selected={id === section}
											title={t(`settings.section.${id}`)}
										/>
									);
								})}
							</div>
						))}
					</nav>
					<div className="settings-content min-h-0 min-w-0 flex-1 overflow-y-auto" ref={contentRef}>
						<main aria-labelledby="settings-section-title" className="settings-column">
							<header className="mb-6">
								<h2 className="text-sc-2xl font-semibold text-(--sc-text)" id="settings-section-title">
									{results ? t("settings.search.title") : sectionTitle}
								</h2>
								<p className="mt-1 text-sc-sm text-(--sc-text-muted)">
									{results
										? t("settings.search.count", { count: results.length })
										: t(`settings.section.${section}.desc`)}
								</p>
							</header>
							{AGENT_SECTIONS[section] && !data.sidecarReady && (
								<SettingsConnectionBanner
									busy={data.sidecarBusy}
									error={sidecarError}
									onRetry={data.retry}
									status={sidecarStatus}
								/>
							)}
							{AGENT_SECTIONS[section] && data.sidecarReady && data.loadState === "error" && (
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
									<EmptyState description={t("settings.search.emptyDesc")} title={t("settings.noMatches")} />
								) : (
									<div className="flex flex-col gap-0.5" data-settings-search-results="true">
										{results.map(result => (
											<ListRow
												description={result.path ? `${result.location} · ${result.path}` : result.location}
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
									{renderSection()}
								</div>
							)}
						</main>
					</div>
				</div>
			</SettingsNavigationProvider>
		</SettingsDataProvider>
	);
}
