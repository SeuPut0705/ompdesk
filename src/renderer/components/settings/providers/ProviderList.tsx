/**
 * The provider catalog as a searchable list: connected first, a short
 * recommended set next, and the long tail collapsed behind one button. Rows
 * are calm (ListRow); "Connect" is a quiet row action and the row itself, so
 * eighty providers never become eighty primary buttons. The first-run setup
 * shows the whole list; Settings › Models & providers lists the connected
 * ones itself (`ProviderItem`) and shows only the rest here (`available`).
 */

import { CheckCircle2, ChevronDown, ChevronUp, CircleDashed, KeyRound, LogOut, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ProviderInfo, ProvidersResult } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { Badge, Button, EmptyState, IconButton, ListRow, SearchField, Spinner } from "../../common";
import { type ProviderLogin, ProviderLoginPanel } from "./ProviderLogin";
import { groupProviders } from "./provider-catalog";

type TFn = (key: string, params?: Record<string, string | number>) => string;

export interface ProviderCatalog {
	providers: ProviderInfo[];
	customConfigs: CustomProviderView[];
	loading: boolean;
	/** Provider read failed (the list may still show the last good catalog). */
	error: string | null;
	/** models.yml could not be read. */
	configError: string | null;
	refreshPending: boolean;
	sidecarReady: boolean;
	load: (forceRefresh?: boolean) => Promise<ProvidersResult | undefined>;
}

/**
 * Provider rows are catalog state in the model store (a `get_providers` read
 * and a `model_catalog_update` push race through its generation guard); what
 * stays here is what no read carries — the editable models.yml entries — and
 * this surface's transient flags.
 */
export function useProviderCatalog({
	active = true,
	pollMs = 2_500,
}: {
	active?: boolean;
	pollMs?: number;
} = {}): ProviderCatalog {
	const tabRpc = useTabRpc();
	// models.yml lives with the focused tab's omp: a paired host's own file.
	const device = useFocusedTabDevice();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const providers = useModelStore(state => state.providers);
	const refreshPending = useModelStore(state => state.catalogRefreshPending);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const [customConfigs, setCustomConfigs] = useState<CustomProviderView[]>([]);
	const [configError, setConfigError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const requestVersion = useRef(0);

	const load = useCallback(
		async (forceRefresh = false): Promise<ProvidersResult | undefined> => {
			const version = ++requestVersion.current;
			setError(null);
			if (!sidecarReady) {
				setError(t("providers.notConnected"));
				return undefined;
			}
			setLoading(true);
			try {
				const [providerResult, configsResult] = await Promise.allSettled([
					refreshProviders(forceRefresh),
					window.omp.models.listProviders(device),
				]);
				if (version !== requestVersion.current) return undefined;
				if (configsResult.status === "fulfilled") {
					setCustomConfigs(configsResult.value);
					setConfigError(null);
				} else {
					setConfigError(t("providers.configFailed", { details: String(configsResult.reason) }));
				}
				if (providerResult.status === "rejected") {
					const cause = providerResult.reason;
					setError(cause instanceof Error ? cause.message : String(cause));
					return undefined;
				}
				return providerResult.value;
			} finally {
				if (version === requestVersion.current) setLoading(false);
			}
		},
		[device, refreshProviders, sidecarReady, t],
	);

	// A read can be superseded by a tab switch; the store guard replaces the
	// list, so this surface's own flags have to be released the same way.
	// biome-ignore lint/correctness/useExhaustiveDependencies: tabRpc is the only signal that the task these responses belong to changed.
	useEffect(() => {
		requestVersion.current++;
		setLoading(false);
		setError(null);
	}, [tabRpc]);

	useEffect(() => {
		if (active) void load();
	}, [active, load]);

	useEffect(() => {
		// `refreshPending`: the sidecar stopped waiting on discovery for this read
		// and nothing pushes the answer here, so keep asking with cheap reads.
		if (!active || !refreshPending) return;
		const timer = setInterval(() => void load(), pollMs);
		return () => clearInterval(timer);
	}, [active, refreshPending, load, pollMs]);

	return { providers, customConfigs, loading, error, configError, refreshPending, sidecarReady, load };
}

function SectionLabel({ children, level }: { children: ReactNode; level: "h3" | "h4" }) {
	const Heading = level;
	return (
		<Heading className="px-2.5 pt-4 pb-1 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
			{children}
		</Heading>
	);
}

function authLabel(provider: ProviderInfo, t: TFn): string {
	if (provider.authKind === "oauth") return t("providers.badge.oauth");
	if (provider.authKind === "env") return t("providers.badge.env");
	return t("providers.badge.apikey");
}

export interface RowHandlers {
	onConnect: (provider: ProviderInfo) => void;
	onLogout?: (provider: ProviderInfo) => void;
	onEditConfig?: (config: CustomProviderView) => void;
	onDeleteConfig?: (config: CustomProviderView) => void;
}

/** A row that expands what renders under it (a subscription's accounts). */
export interface RowDisclosure {
	expanded: boolean;
	onToggle: () => void;
	/** id of the expanded region. */
	controls: string;
}

export function ProviderRow({
	provider,
	config,
	busy,
	sidecarReady,
	listsAccounts = false,
	summary,
	disclosure,
	handlers,
}: {
	provider: ProviderInfo;
	/** The user-owned models.yml entry with this id, if any. */
	config: CustomProviderView | undefined;
	busy: boolean;
	sidecarReady: boolean;
	/** The accounts render under the row, so the row names none. */
	listsAccounts?: boolean;
	/** Leading part of the description (the account count). */
	summary?: string;
	disclosure?: RowDisclosure;
	handlers: RowHandlers;
}) {
	const t = useT();
	const connected = provider.authenticated;
	const editable = config && !config.builtin ? config : undefined;
	// A key written in models.yml is reinstalled by every catalog reload, so
	// signing out would clear a credential the provider never used; editing
	// the entry is what actually removes it.
	const canLogout = connected && handlers.onLogout && !config?.hasApiKey;
	const description = [
		summary,
		listsAccounts ? null : provider.account,
		provider.modelCount === 1
			? t("providers.modelOne")
			: provider.modelCount > 0
				? t("providers.models", { count: provider.modelCount })
				: null,
		provider.baseUrl,
	]
		.filter(Boolean)
		.join(" · ");
	const connect = () => handlers.onConnect(provider);
	const onClick = disclosure
		? disclosure.onToggle
		: !connected && provider.loginAvailable && sidecarReady
			? connect
			: editable && handlers.onEditConfig
				? () => handlers.onEditConfig?.(editable)
				: undefined;
	return (
		<ListRow
			actions={
				busy ? undefined : (
					<>
						{!connected && provider.loginAvailable && (
							<Button
								disabled={!sidecarReady}
								onClick={connect}
								size="sm"
								title={sidecarReady ? undefined : t("providers.notConnected")}
								variant="secondary"
							>
								{t("providerList.connect")}
							</Button>
						)}
						{connected && provider.loginAvailable && (
							<IconButton
								disabled={!sidecarReady}
								icon={<KeyRound />}
								label={t("providers.updateCredentials", { provider: provider.name })}
								onClick={connect}
								size="sm"
							/>
						)}
						{editable && handlers.onEditConfig && (
							<IconButton
								icon={<Pencil />}
								label={t("providers.edit")}
								onClick={() => handlers.onEditConfig?.(editable)}
								size="sm"
							/>
						)}
						{canLogout && (
							<IconButton
								disabled={!sidecarReady}
								icon={<LogOut />}
								label={listsAccounts ? t("providers.logoutAll") : t("providers.logout")}
								onClick={() => handlers.onLogout?.(provider)}
								size="sm"
							/>
						)}
						{editable && handlers.onDeleteConfig && (
							<IconButton
								icon={<Trash2 />}
								label={t("providerCfg.list.delete")}
								onClick={() => handlers.onDeleteConfig?.(editable)}
								size="sm"
							/>
						)}
					</>
				)
			}
			description={description || undefined}
			leading={
				connected ? (
					<CheckCircle2 aria-label={t("providerList.connected")} className="text-(--sc-success)" />
				) : (
					<CircleDashed aria-hidden />
				)
			}
			meta={
				busy ? (
					<Spinner size="sm" />
				) : provider.disabled ? (
					<Badge variant="warning">{t("providers.badge.disabled")}</Badge>
				) : connected ? (
					authLabel(provider, t)
				) : undefined
			}
			buttonProps={
				disclosure ? { "aria-expanded": disclosure.expanded, "aria-controls": disclosure.controls } : undefined
			}
			onClick={onClick}
			title={provider.name}
			titleText={provider.id === provider.name ? undefined : provider.id}
			trailing={
				disclosure ? (
					<ChevronDown
						aria-hidden
						className={cx(
							"size-(--sc-icon-sm) text-(--sc-text-muted) transition-transform duration-(--sc-duration-fast) motion-reduce:transition-none",
							disclosure.expanded && "rotate-180",
						)}
					/>
				) : undefined
			}
		/>
	);
}

/**
 * One provider as a list item: its row, whatever expands under it (the
 * accounts), and the inline sign-in while one for it is open.
 */
export function ProviderItem({
	provider,
	config,
	login,
	busyProvider,
	sidecarReady,
	handlers,
	summary,
	disclosure,
	children,
}: {
	provider: ProviderInfo;
	config: CustomProviderView | undefined;
	login: ProviderLogin;
	busyProvider: string | null;
	sidecarReady: boolean;
	handlers: RowHandlers;
	summary?: string;
	disclosure?: RowDisclosure;
	/** Rendered under the row; its presence means the row names no account. */
	children?: ReactNode;
}) {
	return (
		<li>
			<ProviderRow
				busy={busyProvider === provider.id || (login.state.running && login.state.providerId === provider.id)}
				config={config}
				disclosure={disclosure}
				handlers={handlers}
				listsAccounts={children !== undefined}
				provider={provider}
				sidecarReady={sidecarReady}
				summary={summary}
			/>
			{children}
			{login.state.providerId === provider.id && (
				<div className="px-2.5 pt-1 pb-2">
					<ProviderLoginPanel
						login={login}
						onRetry={() => void login.start(provider.id)}
						providerName={provider.name}
					/>
				</div>
			)}
		</li>
	);
}

export function ProviderList({
	catalog,
	login,
	busyProvider = null,
	onEditConfig,
	onDeleteConfig,
	onAddCustom,
	available = false,
	autoFocusSearch = false,
}: {
	catalog: ProviderCatalog;
	login: ProviderLogin;
	busyProvider?: string | null;
	onEditConfig?: (config: CustomProviderView) => void;
	onDeleteConfig?: (config: CustomProviderView) => void;
	/** Offered when a search finds nothing. */
	onAddCustom?: () => void;
	/**
	 * Only what is not connected yet (the Settings "Add a provider" picker):
	 * the connected providers and models.yml entries are listed elsewhere there.
	 */
	available?: boolean;
	autoFocusSearch?: boolean;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);
	const { providers, customConfigs, loading, sidecarReady } = catalog;
	const groups = groupProviders(providers, query);
	const connected = available ? [] : groups.connected;
	const searching = query.trim().length > 0;
	const configById = new Map(customConfigs.map(config => [config.id, config]));
	// A models.yml entry the session lists no models for is absent from the
	// catalog, which reads as "the add did nothing": list it with the reason.
	const unlisted = available
		? []
		: customConfigs.filter(
				config =>
					!config.builtin &&
					!providers.some(provider => provider.id === config.id) &&
					(!searching || config.id.includes(query.trim().toLowerCase())),
			);
	const handlers: RowHandlers = {
		onConnect: provider => void login.start(provider.id),
		onEditConfig,
		onDeleteConfig,
	};
	const level = available ? "h4" : "h3";

	const renderRow = (provider: ProviderInfo) => (
		<ProviderItem
			busyProvider={busyProvider}
			config={configById.get(provider.id)}
			handlers={handlers}
			key={provider.id}
			login={login}
			provider={provider}
			sidecarReady={sidecarReady}
		/>
	);

	const empty = connected.length + groups.recommended.length + groups.others.length + unlisted.length === 0;
	const tailOpen = searching || showAll || (connected.length + groups.recommended.length === 0 && !loading);

	return (
		<div className="flex flex-col">
			<SearchField
				autoFocus={autoFocusSearch}
				label={t("providerList.search")}
				onValueChange={setQuery}
				placeholder={t("providerList.searchPlaceholder")}
				value={query}
			/>
			{loading && providers.length === 0 ? (
				<div className="flex justify-center py-8">
					<Spinner label={t("providerList.loading")} />
				</div>
			) : empty ? (
				<EmptyState
					actions={
						onAddCustom && (
							<Button onClick={onAddCustom} size="sm" variant="secondary">
								{t("providerList.addCustom")}
							</Button>
						)
					}
					className="py-8"
					description={searching ? t("providerList.noMatchHint") : undefined}
					size="sm"
					title={searching ? t("providerList.noMatch", { query: query.trim() }) : t("providerList.empty")}
				/>
			) : (
				<>
					{(connected.length > 0 || unlisted.length > 0) && (
						<section aria-label={t("providerList.section.connected")}>
							<SectionLabel level={level}>{t("providerList.section.connected")}</SectionLabel>
							<ul>
								{connected.map(renderRow)}
								{unlisted.map(config => (
									<li key={`config:${config.id}`}>
										<ListRow
											actions={
												<>
													{onEditConfig && (
														<IconButton
															icon={<Pencil />}
															label={t("providers.edit")}
															onClick={() => onEditConfig(config)}
															size="sm"
														/>
													)}
													{onDeleteConfig && (
														<IconButton
															icon={<Trash2 />}
															label={t("providerCfg.list.delete")}
															onClick={() => onDeleteConfig(config)}
															size="sm"
														/>
													)}
												</>
											}
											description={t("providerList.noModels")}
											leading={<CircleDashed aria-hidden className="text-(--sc-warning)" />}
											onClick={onEditConfig ? () => onEditConfig(config) : undefined}
											title={config.id}
										/>
									</li>
								))}
							</ul>
						</section>
					)}
					{groups.recommended.length > 0 && (
						<section aria-label={t("providerList.section.recommended")}>
							<SectionLabel level={level}>{t("providerList.section.recommended")}</SectionLabel>
							<ul>{groups.recommended.map(renderRow)}</ul>
						</section>
					)}
					{groups.others.length > 0 && (
						<section aria-label={t("providerList.section.others")}>
							{tailOpen ? (
								<>
									<SectionLabel level={level}>{t("providerList.section.others")}</SectionLabel>
									<ul>{groups.others.map(renderRow)}</ul>
									{!searching && showAll && (
										<Button
											className="mt-1 self-start"
											icon={<ChevronUp />}
											onClick={() => setShowAll(false)}
											size="sm"
											variant="ghost"
										>
											{t("providerList.showLess")}
										</Button>
									)}
								</>
							) : (
								<Button
									aria-expanded={false}
									className="mt-3 self-start"
									icon={<ChevronDown />}
									onClick={() => setShowAll(true)}
									size="sm"
									variant="ghost"
								>
									{t("providerList.showMore", { count: groups.others.length })}
								</Button>
							)}
						</section>
					)}
				</>
			)}
		</div>
	);
}
