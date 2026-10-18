/**
 * Settings › Models & accounts › Providers & accounts — connection only, in
 * three parts: "Providers & accounts" is ONE open list of every signed-in
 * account, a row each (brand mark, provider, account, state, tightest live
 * quota, an overflow menu for the actions), sorted by company with a
 * provider's accounts adjacent and nothing grouped or collapsed
 * (ProviderAccounts, ConnectedRow); then the account-switching mode, and
 * "Add a provider", a compact searchable grid of marks and names
 * (ProviderPicker). "Custom endpoints" lists this machine's models.yml entries
 * (neutral first-letter mark) and opens the inline form (`ui.providerForm`,
 * opened by `openProviderConfig`) in place of all of them. The model roles
 * come after, in `modelSettings`; "Account pools" (AccountPoolsEditor, omp
 * 18.8.1+ only) limits which of those accounts each agent may use, from the
 * same account reads, folded under Advanced. A failed read is a quiet
 * InlineNotice in the part it concerns. A tab on a paired host edits the
 * host's models.yml in-app; "Edit config" opens this device's file only, so it
 * is not offered there.
 */

import { CircleDashed, FileCode2, KeyRound, LogOut, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ProviderAccountsResult, ProviderInfo } from "../../../../shared/rpc-types";
import { useUsage } from "../../../hooks/use-usage-reports";
import { errorDetail } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import {
	Badge,
	Button,
	ConfirmDialog,
	type ContextMenuItem,
	IconButton,
	InlineNotice,
	ListRow,
	Spinner,
} from "../../common";
import { SettingsAdvanced, SettingsSection } from "../SettingsLayout";
import { AccountPoolsEditor } from "./AccountPoolsEditor";
import { ConnectedRow } from "./ConnectedRow";
import { CustomProviderForm } from "./CustomProviderForm";
import { ModelOverrides } from "./ModelOverrides";
import { ProviderAccountRows, useProviderAccounts } from "./ProviderAccounts";
import {
	authLabel,
	type ProviderCatalog,
	type RowHandlers,
	unlistedCustomReason,
	useProviderCatalog,
} from "./ProviderList";
import { type ProviderLogin, ProviderLoginPanel, useProviderLogin } from "./ProviderLogin";
import { ProviderMark } from "./ProviderMark";
import { ProviderPicker } from "./ProviderPicker";
import { groupProviders, providerDiscoveryErrors } from "./provider-catalog";
import { sortProvidersByCompany } from "./provider-marks";
import { RotationModeControl } from "./RotationModeControl";

/** A subscription sign-in can hold several accounts (stock lists them for OAuth providers). */
function listsAccounts(provider: ProviderInfo): boolean {
	return provider.authenticated && provider.authKind === "oauth" && provider.loginAvailable;
}

/** The row(s) of one connected provider: an account each for a subscription, else one row. */
function ConnectedProviderRows({
	provider,
	config,
	login,
	busyProvider,
	sidecarReady,
	handlers,
	revision,
	usagePolls,
	onChanged,
	onAccounts,
}: {
	provider: ProviderInfo;
	config: CustomProviderView | undefined;
	login: ProviderLogin;
	busyProvider: string | null;
	sidecarReady: boolean;
	handlers: RowHandlers;
	revision: number;
	/** The tab's usage poll count (`UsageFeed.polls`): each move re-reads the account quotas. */
	usagePolls: number;
	onChanged: () => Promise<unknown>;
	/** Each account read of this provider, for the account pool editor (one read serves both). */
	onAccounts: (providerId: string, result: ProviderAccountsResult | null) => void;
}) {
	const t = useT();
	const accounts = listsAccounts(provider);
	const state = useProviderAccounts(provider.id, accounts && sidecarReady, revision, usagePolls);
	useEffect(() => onAccounts(provider.id, state.result), [onAccounts, provider.id, state.result]);
	if (accounts) {
		return (
			<ProviderAccountRows
				adding={login.state.running}
				onAdd={() => void login.start(provider.id)}
				onChanged={onChanged}
				onSignOutAll={() => handlers.onLogout?.(provider)}
				provider={provider}
				sidecarReady={sidecarReady}
				state={state}
			/>
		);
	}
	// A key written in models.yml is reinstalled by every catalog reload, so
	// signing out would clear a credential the provider never used; editing
	// the entry is what actually removes it.
	const canLogout = handlers.onLogout && !config?.hasApiKey;
	const menu: ContextMenuItem[] = [
		...(provider.loginAvailable
			? [
					{
						id: "credentials",
						label: t("providers.updateCredentials", { provider: provider.name }),
						icon: KeyRound,
						disabled: !sidecarReady,
						onSelect: () => handlers.onConnect(provider),
					},
				]
			: []),
		...(canLogout
			? [
					{
						id: "sign-out",
						label: t("providers.logout"),
						icon: LogOut,
						danger: true,
						disabled: !sidecarReady,
						onSelect: () => handlers.onLogout?.(provider),
					},
				]
			: []),
	];
	return (
		<ConnectedRow
			account={[
				provider.account ?? authLabel(provider, t),
				provider.modelCount === 1
					? t("providers.modelOne")
					: provider.modelCount > 0
						? t("providers.models", { count: provider.modelCount })
						: null,
			]
				.filter(Boolean)
				.join(" · ")}
			accountTitle={provider.baseUrl}
			badges={provider.disabled && <Badge variant="warning">{t("providers.badge.disabled")}</Badge>}
			busy={busyProvider === provider.id || (login.state.running && login.state.providerId === provider.id)}
			menu={menu}
			provider={provider}
		/>
	);
}

function CustomEndpoints({
	catalog,
	busyProvider,
	onEdit,
	onDelete,
}: {
	catalog: ProviderCatalog;
	busyProvider: string | null;
	onEdit: (config: CustomProviderView) => void;
	onDelete: (config: CustomProviderView) => void;
}) {
	const t = useT();
	const device = useFocusedTabDevice();
	const openProviderConfig = useUiStore(state => state.openProviderConfig);
	const configs = catalog.customConfigs.filter(config => !config.builtin);
	const listed = new Map(catalog.providers.map(provider => [provider.id, provider]));
	return (
		<SettingsSection
			actions={
				<>
					{device === undefined && (
						<Button
							icon={<FileCode2 />}
							onClick={() => {
								void window.omp.models.openConfig().catch(cause => {
									toastError({ title: t("providers.editConfig"), error: cause });
								});
							}}
							size="sm"
							variant="ghost"
						>
							{t("providers.editConfig")}
						</Button>
					)}
					<Button
						data-custom-add
						icon={<Plus />}
						onClick={() => openProviderConfig()}
						size="sm"
						variant="secondary"
					>
						{t("providerList.addCustom")}
					</Button>
				</>
			}
			description={t("settings.models.customDesc")}
			id="settings-models-custom"
			title={t("settings.models.custom")}
		>
			{catalog.configError && <InlineNotice title={catalog.configError} tone="warning" />}
			{configs.length === 0 ? (
				!catalog.configError && (
					<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("providers.custom.empty")}</p>
				)
			) : (
				<ul>
					{configs.map(config => {
						const provider = listed.get(config.id);
						const models = provider?.modelCount ?? 0;
						const description = [
							provider === undefined
								? unlistedCustomReason(config, t)
								: models === 1
									? t("providers.modelOne")
									: t("providers.models", { count: models }),
							config.baseUrl,
						]
							.filter(Boolean)
							.join(" · ");
						return (
							<li key={config.id}>
								<ListRow
									actions={
										busyProvider === config.id ? undefined : (
											<>
												<IconButton
													icon={<Pencil />}
													label={t("providers.edit")}
													onClick={() => onEdit(config)}
													size="sm"
												/>
												<IconButton
													icon={<Trash2 />}
													label={t("providerCfg.list.delete")}
													onClick={() => onDelete(config)}
													size="sm"
												/>
											</>
										)
									}
									description={description}
									leading={<ProviderMark neutral provider={{ id: config.id, name: config.id }} />}
									meta={
										busyProvider === config.id ? (
											<Spinner size="sm" spin />
										) : provider === undefined ? (
											<CircleDashed aria-hidden className="size-(--sc-icon-sm) text-(--sc-warning)" />
										) : undefined
									}
									onClick={() => onEdit(config)}
									rowProps={{ "data-custom-provider": config.id }}
									title={config.id}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</SettingsSection>
	);
}

export function ProvidersSection({
	pollMs = 2_500,
	advancedSettings,
	modelSettings,
}: {
	pollMs?: number;
	/** Leads the folded Advanced group, before account pools, custom endpoints and model overrides. */
	advancedSettings?: ReactNode;
	modelSettings?: ReactNode;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const device = useFocusedTabDevice();
	const pickerId = useId();
	const catalog = useProviderCatalog({ pollMs });
	const discoveryStates = useModelStore(state => state.discoveryStates);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const providerForm = useUiStore(state => state.providerForm);
	const openProviderConfig = useUiStore(state => state.openProviderConfig);
	const closeProviderForm = useUiStore(state => state.closeProviderForm);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);
	const [pendingLogout, setPendingLogout] = useState<ProviderInfo | null>(null);
	const [pendingDelete, setPendingDelete] = useState<CustomProviderView | null>(null);
	/** "Add a provider" picker; `null` until toggled: open only while nothing is connected. */
	const [pickerOpen, setPickerOpen] = useState<boolean | null>(null);
	/** Bumped after any sign-in or sign-out here: the account lists read again. */
	const [accountsRevision, setAccountsRevision] = useState(0);
	/** Each connected row's latest account read, by provider id: the account pool editor's accounts. */
	const [accountResults, setAccountResults] = useState<Record<string, ProviderAccountsResult | null>>({});
	const onAccounts = useCallback((providerId: string, result: ProviderAccountsResult | null) => {
		setAccountResults(previous =>
			previous[providerId] === result ? previous : { ...previous, [providerId]: result },
		);
	}, []);
	const { providers, load } = catalog;
	// The account rows' quotas follow the tab's one usage poll, joined here once while any row lists accounts.
	const usagePolls = useUsage(feed => feed.polls, !(providerForm && catalog.options) && providers.some(listsAccounts));

	const onConnected = useCallback(
		async (providerId: string) => {
			const before = providers.find(provider => provider.id === providerId);
			await load(true);
			setAccountsRevision(revision => revision + 1);
			// A provider connected from the picker now sits under Connected; the picker
			// (and a search that only it matched) folds away instead of saying nothing matches.
			if (!before?.authenticated) setPickerOpen(null);
			toast({ variant: "success", message: t("providers.loginSuccess", { provider: before?.name ?? providerId }) });
		},
		[load, providers, t],
	);
	const login = useProviderLogin(onConnected);
	/**
	 * The form stands in for the whole section, so closing it lands back at the
	 * top. This is the endpoint it saved or edited ("" after cancelling an add):
	 * once the list shows it, it scrolls into view and takes focus.
	 */
	const [returnTo, setReturnTo] = useState<string | null>(null);
	const customConfigs = catalog.customConfigs;
	const reloading = catalog.loading;
	useEffect(() => {
		if (providerForm || returnTo === null || reloading) return;
		// After the reload a save starts: the rows above have settled, and a new endpoint is listed.
		if (returnTo && !customConfigs.some(config => config.id === returnTo)) return;
		const section = document.getElementById("settings-models-custom");
		const row = returnTo
			? Array.from(section?.querySelectorAll<HTMLElement>("[data-custom-provider]") ?? []).find(
					item => item.dataset.customProvider === returnTo,
				)
			: section?.querySelector<HTMLElement>("[data-custom-add]");
		// Centered, so the whole row stays clear of the window edge and the toasts it raised.
		row?.scrollIntoView({ block: "center" });
		(returnTo ? row?.querySelector<HTMLElement>("button") : row)?.focus({ preventScroll: true });
		setReturnTo(null);
	}, [providerForm, returnTo, customConfigs, reloading]);

	/** Provider-wide sign-out: every stored account. One account is removed from its own row. */
	const logout = async (provider: ProviderInfo) => {
		setPendingLogout(null);
		setBusyProvider(provider.id);
		try {
			const response = await tabRpc.disconnectProvider(provider.id);
			if (!response.success) {
				toastError({ title: t("providers.logoutFailed"), error: response });
				return;
			}
			// A non-forced read answers from a still-fresh cache row, which is how
			// a signed-out provider used to keep showing as connected.
			const fresh = await load(true);
			setAccountsRevision(revision => revision + 1);
			toast({ variant: "success", message: t("providers.logoutSuccess", { provider: provider.name }) });
			if (fresh?.providers.some(row => row.id === provider.id && row.authenticated)) {
				toast({ variant: "warning", message: t("providers.logoutKept", { provider: provider.name }) });
			}
		} catch (cause) {
			toastError({ title: t("providers.logoutFailed"), error: cause });
		} finally {
			setBusyProvider(null);
		}
	};

	const deleteConfig = async (config: CustomProviderView) => {
		setBusyProvider(config.id);
		try {
			await window.omp.models.deleteProvider(config.id, device);
			try {
				await refreshProviders(true);
			} catch (cause) {
				toast({ variant: "warning", message: t("providerCfg.toast.refreshFailed"), detail: errorDetail(cause) });
			}
			toast({ variant: "success", message: t("providerCfg.toast.deleted", { id: config.id }) });
			setPendingDelete(null);
			await load();
		} catch (cause) {
			toastError({ title: t("providerCfg.toast.deleteFailed"), error: cause });
		} finally {
			setBusyProvider(null);
		}
	};

	if (providerForm && catalog.options) {
		return (
			<SettingsSection id="settings-models-custom">
				<CustomProviderForm
					editing={providerForm.edit}
					existing={catalog.customConfigs}
					options={catalog.options}
					key={providerForm.edit?.id ?? "new"}
					onCancel={() => {
						setReturnTo(providerForm.edit?.id ?? "");
						closeProviderForm();
					}}
					onSaved={providerId => {
						toast({ variant: "success", message: t("providerCfg.toast.saved", { id: providerId }) });
						setReturnTo(providerId);
						// Reload first: the list that replaces the form then waits for it before scrolling.
						void load();
						closeProviderForm();
					}}
				/>
			</SettingsSection>
		);
	}

	const discoveryErrors = providerDiscoveryErrors(discoveryStates, t("providers.discoveryUnavailable"));
	const connected = sortProvidersByCompany(groupProviders(providers).connected);
	const configById = new Map(catalog.customConfigs.map(config => [config.id, config]));
	const handlers: RowHandlers = {
		onConnect: provider => void login.start(provider.id),
		onLogout: setPendingLogout,
	};
	const showPicker = pickerOpen ?? connected.length === 0;

	return (
		<>
			<SettingsSection
				actions={
					<IconButton
						disabled={!catalog.sidecarReady}
						icon={<RefreshCw />}
						label={catalog.sidecarReady ? t("common.refresh") : t("providers.notConnected")}
						loading={catalog.loading}
						onClick={() => void load(true)}
						size="sm"
					/>
				}
				description={t("providerList.intro")}
				id="settings-models-accounts"
				title={t("settings.models.providers")}
			>
				{catalog.error && (
					<InlineNotice
						action={
							<Button
								disabled={!catalog.sidecarReady}
								icon={<RefreshCw />}
								onClick={() => void load(true)}
								size="sm"
								variant="ghost"
							>
								{t("common.retry")}
							</Button>
						}
						detail={catalog.error}
						live
						title={providers.length > 0 ? t("providers.stale") : t("providers.loadFailed")}
						tone="danger"
					/>
				)}
				{discoveryErrors.length > 0 && (
					<InlineNotice
						title={t("providers.discoveryFailed", { details: discoveryErrors.join("; ") })}
						tone="warning"
					/>
				)}
				{catalog.refreshPending && <InlineNotice title={t("providers.refreshPending")} tone="pending" />}

				{connected.length > 0 && (
					<ul
						aria-label={t("providerList.section.connected")}
						className="flex flex-col divide-y divide-(--sc-divider)"
						data-provider-list
					>
						{connected.map(provider => (
							<ConnectedProviderRows
								busyProvider={busyProvider}
								config={configById.get(provider.id)}
								handlers={handlers}
								key={provider.id}
								login={login}
								onAccounts={onAccounts}
								onChanged={() => load(true)}
								provider={provider}
								revision={accountsRevision}
								sidecarReady={catalog.sidecarReady}
								usagePolls={usagePolls}
							/>
						))}
					</ul>
				)}
				{login.state.providerId !== null && (
					<div className="px-2.5 pt-1 pb-2" data-login-panel>
						<ProviderLoginPanel
							login={login}
							onRetry={() => void login.start(login.state.providerId ?? "")}
							providerName={
								providers.find(row => row.id === login.state.providerId)?.name ?? login.state.providerId
							}
						/>
					</div>
				)}

				{connected.some(
					provider => provider.authKind === "oauth" && provider.loginAvailable && provider.authenticated,
				) && (
					<div
						className="mx-2.5 my-2 border-t border-(--sc-divider) pt-3"
						data-models-rotation="true"
						id="settings-models-rotation"
					>
						<RotationModeControl device={device} />
					</div>
				)}

				{connected.length > 0 && (
					<Button
						aria-controls={pickerId}
						aria-expanded={showPicker}
						className="mt-1"
						icon={<Plus />}
						onClick={() => setPickerOpen(!showPicker)}
						size="sm"
						variant="ghost"
					>
						{t("providers.add")}
					</Button>
				)}
				{showPicker && (
					<div className="mt-2" id={pickerId}>
						<ProviderPicker
							autoFocusSearch={pickerOpen === true}
							busyProvider={busyProvider}
							catalog={catalog}
							login={login}
							onAddCustom={() => openProviderConfig()}
						/>
					</div>
				)}

				<ConfirmDialog
					busy={pendingLogout !== null && busyProvider === pendingLogout.id}
					confirmLabel={t("providers.logoutConfirm")}
					message={t("providers.logoutBody", { provider: pendingLogout?.name ?? "" })}
					onCancel={() => setPendingLogout(null)}
					onConfirm={() => {
						if (pendingLogout) void logout(pendingLogout);
					}}
					open={pendingLogout !== null}
					title={t("providers.logoutTitle", { provider: pendingLogout?.name ?? "" })}
					warning={t("providers.logoutWarning")}
				/>
				<ConfirmDialog
					busy={pendingDelete !== null && busyProvider === pendingDelete.id}
					confirmLabel={t("providerCfg.delete.confirm")}
					message={t("providerCfg.delete.body", { id: pendingDelete?.id ?? "" })}
					onCancel={() => setPendingDelete(null)}
					onConfirm={() => {
						if (pendingDelete) void deleteConfig(pendingDelete);
					}}
					open={pendingDelete !== null}
					title={t("providerCfg.delete.title")}
				/>
			</SettingsSection>
			{/* Connection ends here: accounts, live quota, rotation and the user's own endpoints. */}
			<CustomEndpoints
				busyProvider={busyProvider}
				catalog={catalog}
				onDelete={setPendingDelete}
				onEdit={config => openProviderConfig(config)}
			/>
			{modelSettings}
			{/* Reset passes, account pools and model overrides: rarely changed, folded. */}
			<SettingsAdvanced>
				{advancedSettings}
				<AccountPoolsEditor
					providers={connected.map(provider => ({ provider, result: accountResults[provider.id] ?? null }))}
					sidecarReady={catalog.sidecarReady}
				/>
				<ModelOverrides catalog={catalog} />
			</SettingsAdvanced>
		</>
	);
}
