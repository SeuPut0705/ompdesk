/**
 * Settings › Plugins & resources: one section with underline tabs over the
 * session's installed plugins, configured marketplaces and prompt templates.
 * The page owns the active tab and the single search
 * field (`query`, empty = no filter). Each tab lazy-loads its RPC on first
 * view and caches until refreshed.
 *
 * The Plugins tab is interactive: rows toggle via set_plugin_enabled
 * (optimistic — revert + error toast on failure, re-fetch on success), and
 * clicking a row opens the plugin detail Sheet (features + settings editor,
 * see panels/inventory/PluginDetailSheet). The Marketplaces tab manages
 * sources and catalog installs via marketplace_action (see
 * panels/inventory/MarketplacesSection). Templates stay read-only
 * (no set_* RPC exists for them).
 */

import { ChevronRight, FileText, PackageOpen, RefreshCw, Search, Store } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	RpcMarketplacesResult,
	RpcPluginInfo,
	RpcPluginsResult,
	RpcPromptTemplateInfo,
	RpcPromptTemplatesResult,
	RpcResponse,
} from "../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	capturePluginActivationOrigin,
	handlePluginActivation,
	isPluginActivationOriginActive,
} from "../../lib/plugin-activation";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	Banner,
	Button,
	EmptyState,
	ErrorDetail,
	IconButton,
	ListRow,
	Spinner,
	Switch,
	type TabItem,
	Tabs,
} from "../common";
import { AddMarketplaceForm, MarketplaceCard } from "../panels/inventory/MarketplacesSection";
import { PluginDetailSheet } from "../panels/inventory/PluginDetailSheet";
import { filterMarketplaces, filterPlugins, filterTemplates } from "../panels/inventory-utils";
import { SettingsRow } from "./SettingsLayout";

export type PluginsTab = "plugins" | "marketplaces" | "templates";

export interface PluginsSectionProps {
	tab: PluginsTab;
	onTabChange: (tab: PluginsTab) => void;
	/** Page search; empty string = no filter. */
	query: string;
}

export interface RpcResource<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	ready: boolean;
	routeKey: string;
	/** True once a fetch has succeeded; cached until the next manual refresh. */
	loaded: boolean;
	reload: () => Promise<void>;
}

/** Fetch-on-demand wrapper around a read-only rpc command with stale-on-error caching. */
export function useRpcResource<T>(fetcher: () => Promise<RpcResponse>): RpcResource<T> {
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const cwd = useSessionStore(s => s.cwd);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const routeReady = useActiveTabRouteReady();
	const routeKey = `${activeTabId ?? "none"}:${cwd}`;
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const requestRef = useRef(0);
	const routeRef = useRef(routeKey);
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);

	const reload = useCallback(async () => {
		if (!sidecarReady || !routeReady) {
			setError(t("invPanel.notConnected"));
			return;
		}
		const request = ++requestRef.current;
		const requestRoute = routeKey;
		setLoading(true);
		setError(null);
		try {
			const res = await fetcherRef.current();
			if (request !== requestRef.current || requestRoute !== routeRef.current) return;
			if (res.success) {
				setData(res.data as T);
				setLoaded(true);
			} else {
				setError(res.error);
			}
		} catch (cause) {
			if (request === requestRef.current && requestRoute === routeRef.current) setError(String(cause));
		} finally {
			if (request === requestRef.current && requestRoute === routeRef.current) setLoading(false);
		}
	}, [sidecarReady, routeReady, routeKey, t]);

	useEffect(() => {
		routeRef.current = routeKey;
		requestRef.current += 1;
		setData(null);
		setError(null);
		setLoading(false);
		setLoaded(false);
	}, [routeKey]);

	return { data, error, loading, loaded, ready: sidecarReady && routeReady, routeKey, reload };
}

/**
 * Load a tab's resource the first time it becomes visible. Failures leave
 * `loaded` false, so revisiting the tab retries once; successes stay cached.
 */
export function useAutoLoad(
	resource: Pick<RpcResource<unknown>, "loaded" | "loading" | "ready" | "reload" | "routeKey">,
	visible: boolean,
): void {
	const attemptedRef = useRef(false);
	const routeRef = useRef(resource.routeKey);
	const { loaded, loading, ready, reload, routeKey } = resource;
	useEffect(() => {
		if (routeRef.current !== routeKey) {
			routeRef.current = routeKey;
			attemptedRef.current = false;
		}
		if (!visible || !ready) {
			attemptedRef.current = false;
			return;
		}
		if (attemptedRef.current || loaded || loading) return;
		attemptedRef.current = true;
		// This hook lives in a child tab while the route-reset effect lives in
		// the parent resource hook. Passive effects mount child-first, so an
		// immediate request can be invalidated by the parent's initial reset and
		// leave the page blank until Refresh is clicked. Start after the current
		// effect flush so route refs are authoritative before the request begins.
		let cancelled = false;
		queueMicrotask(() => {
			if (!cancelled) void reload();
		});
		return () => {
			cancelled = true;
		};
	}, [visible, loaded, loading, ready, reload, routeKey]);
}

// ============================================================================
// Shared chrome
// ============================================================================

/** Tab body: description + count + refresh toolbar, content, footer note. */
function TabPanel({
	visible,
	label,
	description,
	count,
	resource,
	footer,
	children,
}: {
	visible: boolean;
	label: string;
	description?: ReactNode;
	/** "{shown} of {total}" once loaded; omitted for non-list tabs. */
	count?: string;
	resource: RpcResource<unknown>;
	footer: ReactNode;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<div aria-label={label} className={cx("flex flex-col gap-3", !visible && "hidden")} role="tabpanel">
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
				<div className="min-w-0 max-w-2xl flex-1 text-sc-sm text-(--sc-text-muted)">{description}</div>
				<div className="flex shrink-0 items-center gap-2">
					{count && (
						<span className="text-sc-xs whitespace-nowrap tabular-nums text-(--sc-text-muted)">{count}</span>
					)}
					<IconButton
						disabled={!resource.ready}
						icon={<RefreshCw />}
						label={!resource.ready ? t("invPanel.notConnected") : t("common.refresh")}
						loading={resource.loading}
						onClick={() => void resource.reload()}
						size="sm"
					/>
				</div>
			</div>
			{children}
			{footer && <p className="text-sc-xs text-(--sc-text-muted)">{footer}</p>}
		</div>
	);
}

/** Loading / error+Retry / content gate. Keeps stale data visible behind a refresh error banner. */
export function ResourceGate<T>({
	resource,
	children,
}: {
	resource: RpcResource<T>;
	children: (data: T) => ReactNode;
}) {
	const t = useT();
	const retry = (
		<Button
			disabled={!resource.ready}
			onClick={() => void resource.reload()}
			size="sm"
			title={!resource.ready ? t("invPanel.notConnected") : undefined}
		>
			{t("common.retry")}
		</Button>
	);
	if (!resource.data) {
		if (resource.loading) {
			return (
				<div className="flex items-center justify-center py-10">
					<Spinner label={t("common.loading")} />
				</div>
			);
		}
		if (resource.error) {
			return (
				<Banner actions={retry} title={t("common.loadFailed")} variant="danger">
					<ErrorDetail error={resource.error} />
				</Banner>
			);
		}
		return null;
	}
	return (
		<>
			{resource.error && (
				<Banner actions={retry} title={t("common.loadFailed")} variant="danger">
					<ErrorDetail error={resource.error} />
				</Banner>
			)}
			{children(resource.data)}
		</>
	);
}

const LIST = "divide-y divide-(--sc-divider) border-y border-(--sc-divider)";

// ============================================================================
// Plugins tab
// ============================================================================

function PluginsTab({
	resource,
	visible,
	query,
	onOpenDetail,
	onBrowseMarketplaces,
}: {
	resource: RpcResource<RpcPluginsResult>;
	visible: boolean;
	query: string;
	onOpenDetail: (plugin: RpcPluginInfo) => void;
	onBrowseMarketplaces: () => void;
}) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
	useAutoLoad(resource, visible);
	const plugins = useMemo(() => filterPlugins(resource.data?.plugins ?? [], query), [resource.data, query]);
	const total = resource.data?.plugins.length ?? 0;

	/** Optimistic toggle: overlay → set_plugin_enabled → re-fetch on success, revert + toast on error. */
	const handleToggle = async (plugin: RpcPluginInfo): Promise<void> => {
		if (!resource.ready) return;
		const origin = capturePluginActivationOrigin();
		if (!origin) {
			toast({ variant: "warning", message: t("pluginActivation.routePending") });
			return;
		}
		const key = plugin.id ?? `npm:${plugin.name}`;
		const next = !(overrides[key] ?? plugin.enabled);
		setBusyKey(key);
		setOverrides(prev => ({ ...prev, [key]: next }));
		const clearOverride = (): void =>
			setOverrides(prev => {
				if (!(key in prev)) return prev;
				const rest = { ...prev };
				delete rest[key];
				return rest;
			});
		try {
			const res = await tabRpc.setPluginEnabled(plugin.id ?? plugin.name, next, plugin.scope);
			if (!res.success) {
				clearOverride();
				if (isPluginActivationOriginActive(origin)) {
					toastError({ title: t("invPanel.pluginToggleFailed"), error: res });
				}
				return;
			}
			const data = res.data as { activation?: string } | undefined;
			await handlePluginActivation(
				data?.activation,
				{ pluginId: plugin.id ?? plugin.name, expected: next ? "enabled" : "disabled" },
				origin,
			);
			if (isPluginActivationOriginActive(origin)) await resource.reload();
			clearOverride();
		} catch (cause) {
			clearOverride();
			if (isPluginActivationOriginActive(origin)) {
				toastError({ title: t("invPanel.pluginToggleFailed"), error: cause });
			}
		} finally {
			setBusyKey(null);
		}
	};

	return (
		<TabPanel
			count={resource.loaded && total > 0 ? t("invPanel.count", { shown: plugins.length, total }) : undefined}
			footer={t("invPanel.footer.plugins")}
			label={t("invPanel.tabs.plugins")}
			resource={resource}
			visible={visible}
		>
			<ResourceGate resource={resource}>
				{() =>
					plugins.length === 0 ? (
						total === 0 ? (
							<EmptyState
								actions={
									<Button onClick={onBrowseMarketplaces} size="sm">
										{t("invPanel.plugins.browseMarketplaces")}
									</Button>
								}
								description={t("invPanel.plugins.emptyHint")}
								icon={<PackageOpen />}
								size="sm"
								title={t("invPanel.plugins.empty")}
							/>
						) : (
							<EmptyState icon={<Search />} size="sm" title={t("invPanel.noMatch")} />
						)
					) : (
						<div className={cx(LIST, "py-1")}>
							{plugins.map(p => {
								const key = p.id ?? `npm:${p.name}`;
								const enabled = overrides[key] ?? p.enabled;
								const busy = busyKey === key;
								return (
									<ListRow
										description={[p.version && `v${p.version}`, p.id && p.id !== p.name ? p.id : null]
											.filter(Boolean)
											.join(" · ")}
										key={key}
										meta={
											<span className="relative z-(--sc-z-raised) flex items-center gap-1.5">
												{p.marketplace === "npm" ? (
													<Badge variant="info">npm</Badge>
												) : (
													<Badge variant="default">{p.marketplace}</Badge>
												)}
												{p.scope && <Badge variant="muted">{t(`invPanel.scope.${p.scope}`)}</Badge>}
												{p.shadowedBy && (
													<Badge dot variant="warning">
														{t("invPanel.shadowedBy", { scope: t(`invPanel.scope.${p.shadowedBy}`) })}
													</Badge>
												)}
												{busy ? (
													<span className="flex h-(--sc-hit-min) w-8 items-center justify-center">
														<Spinner size="sm" />
													</span>
												) : (
													<Switch
														checked={enabled}
														disabled={busyKey !== null || !resource.ready}
														label={`${p.name}: ${enabled ? t("invPanel.enabled") : t("invPanel.disabled")}`}
														onCheckedChange={() => void handleToggle(p)}
													/>
												)}
												<ChevronRight
													aria-hidden="true"
													className="size-(--sc-icon-sm) text-(--sc-text-muted)"
												/>
											</span>
										}
										onClick={() => onOpenDetail(p)}
										title={p.name}
										titleText={t("pluginDetail.openHint")}
									/>
								);
							})}
						</div>
					)
				}
			</ResourceGate>
		</TabPanel>
	);
}

// ============================================================================
// Marketplaces tab
// ============================================================================

function MarketplacesTab({
	resource,
	visible,
	query,
}: {
	resource: RpcResource<RpcMarketplacesResult>;
	visible: boolean;
	query: string;
}) {
	const t = useT();
	useAutoLoad(resource, visible);
	const marketplaces = useMemo(
		() => filterMarketplaces(resource.data?.marketplaces ?? [], query),
		[resource.data, query],
	);
	const total = resource.data?.marketplaces.length ?? 0;
	return (
		<TabPanel
			count={resource.loaded && total > 0 ? t("invPanel.count", { shown: marketplaces.length, total }) : undefined}
			footer={t("marketplace.footerNote")}
			label={t("invPanel.tabs.marketplaces")}
			resource={resource}
			visible={visible}
		>
			<ResourceGate resource={resource}>
				{() => (
					<>
						<AddMarketplaceForm onAdded={resource.reload} ready={resource.ready} />
						{marketplaces.length === 0 ? (
							total === 0 ? (
								<EmptyState
									description={t("invPanel.marketplaces.emptyHint")}
									icon={<Store />}
									size="sm"
									title={t("invPanel.marketplaces.empty")}
								/>
							) : (
								<EmptyState icon={<Search />} size="sm" title={t("invPanel.noMatch")} />
							)
						) : (
							<div className={LIST}>
								{marketplaces.map(m => (
									<MarketplaceCard
										key={m.name}
										marketplace={m}
										ready={resource.ready}
										reload={resource.reload}
									/>
								))}
							</div>
						)}
					</>
				)}
			</ResourceGate>
		</TabPanel>
	);
}

// ============================================================================
// Prompt templates tab
// ============================================================================

function TemplateRow({ template }: { template: RpcPromptTemplateInfo }) {
	return (
		<SettingsRow
			badge={
				<>
					<Badge variant="muted">{template.source}</Badge>
					{template.argumentHint && (
						<code className="rounded-(--sc-radius-xs) bg-(--sc-surface-3) px-1.5 py-px font-mono text-sc-xs text-(--sc-text-secondary)">
							{template.argumentHint}
						</code>
					)}
				</>
			}
			description={template.description || undefined}
			label={template.name}
		/>
	);
}

function TemplatesTab({
	resource,
	visible,
	query,
}: {
	resource: RpcResource<RpcPromptTemplatesResult>;
	visible: boolean;
	query: string;
}) {
	const t = useT();
	useAutoLoad(resource, visible);
	const templates = useMemo(() => filterTemplates(resource.data?.templates ?? [], query), [resource.data, query]);
	const total = resource.data?.templates.length ?? 0;
	return (
		<TabPanel
			count={resource.loaded && total > 0 ? t("invPanel.count", { shown: templates.length, total }) : undefined}
			footer={t("invPanel.readonlyNote")}
			label={t("invPanel.tabs.templates")}
			resource={resource}
			visible={visible}
		>
			<ResourceGate resource={resource}>
				{() =>
					templates.length === 0 ? (
						total === 0 ? (
							<EmptyState
								description={t("invPanel.templates.emptyHint")}
								icon={<FileText />}
								size="sm"
								title={t("invPanel.templates.empty")}
							/>
						) : (
							<EmptyState icon={<Search />} size="sm" title={t("invPanel.noMatch")} />
						)
					) : (
						<div className={LIST}>
							{templates.map(tpl => (
								<TemplateRow key={`${tpl.source}:${tpl.name}`} template={tpl} />
							))}
						</div>
					)
				}
			</ResourceGate>
		</TabPanel>
	);
}

// ============================================================================
// Section
// ============================================================================

export function PluginsSection({ tab, onTabChange, query }: PluginsSectionProps) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [detailPlugin, setDetailPlugin] = useState<RpcPluginInfo | null>(null);
	const plugins = useRpcResource<RpcPluginsResult>(() => tabRpc.getPlugins());
	const marketplaces = useRpcResource<RpcMarketplacesResult>(() => tabRpc.getMarketplaces());
	const templates = useRpcResource<RpcPromptTemplatesResult>(() => tabRpc.getPromptTemplates());

	const tabs = useMemo<TabItem[]>(
		() => [
			{ id: "plugins", label: t("invPanel.tabs.plugins"), badge: plugins.data?.plugins.length },
			{ id: "marketplaces", label: t("invPanel.tabs.marketplaces"), badge: marketplaces.data?.marketplaces.length },
			{ id: "templates", label: t("invPanel.tabs.templates"), badge: templates.data?.templates.length },
		],
		[t, plugins.data, marketplaces.data, templates.data],
	);

	return (
		<div className="flex flex-col gap-4">
			<p className="max-w-2xl text-sc-xs text-(--sc-text-muted)">{t("settings.resources.description")}</p>
			{/* A narrow column wraps the tab row instead of widening the page. */}
			<Tabs
				activeId={tab}
				ariaLabel={t("settings.resources.title")}
				className="flex-wrap"
				onChange={id => onTabChange(id as PluginsTab)}
				tabs={tabs}
			/>
			<PluginsTab
				onBrowseMarketplaces={() => onTabChange("marketplaces")}
				onOpenDetail={setDetailPlugin}
				query={query}
				resource={plugins}
				visible={tab === "plugins"}
			/>
			<MarketplacesTab query={query} resource={marketplaces} visible={tab === "marketplaces"} />
			<TemplatesTab query={query} resource={templates} visible={tab === "templates"} />
			<PluginDetailSheet onChanged={plugins.reload} onClose={() => setDetailPlugin(null)} plugin={detailPlugin} />
		</div>
	);
}
