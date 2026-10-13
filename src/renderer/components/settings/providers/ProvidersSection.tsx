/**
 * Settings › Models & providers — where the models come from, as two
 * sections: "Providers" lists the connected ones (a subscription expands to
 * its accounts, ProviderAccounts), the account-switching mode, and "Add a
 * provider", a collapsed picker with search, the recommended set and the long
 * tail; "Account pools" (AccountPoolsEditor, omp 18.8.1+ only) limits which of
 * those accounts each agent may use, from the same account reads; "Custom
 * endpoints" lists this machine's models.yml entries and opens
 * the inline form (`ui.providerForm`, opened by `openProviderConfig`) in place
 * of all of them. A failed read is a quiet InlineNotice in the part it concerns.
 * A tab on a paired host edits the host's models.yml in-app; "Edit config"
 * opens this device's file only, so it is not offered there.
 */

import { CircleDashed, FileCode2, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ProviderAccountsResult, ProviderInfo } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, ConfirmDialog, IconButton, ListRow, Spinner } from "../../common";
import { InlineNotice } from "../InlineNotice";
import { SettingsSection } from "../SettingsLayout";
import { AccountPoolsEditor } from "./AccountPoolsEditor";
import { CustomProviderForm } from "./CustomProviderForm";
import { ProviderAccounts, useProviderAccounts } from "./ProviderAccounts";
import { type ProviderCatalog, ProviderItem, ProviderList, type RowHandlers, useProviderCatalog } from "./ProviderList";
import { type ProviderLogin, useProviderLogin } from "./ProviderLogin";
import { groupProviders, providerDiscoveryErrors } from "./provider-catalog";
import { RotationModeControl } from "./RotationModeControl";

function ConnectedProvider({
	provider,
	config,
	login,
	busyProvider,
	sidecarReady,
	handlers,
	revision,
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
	onChanged: () => Promise<unknown>;
	/** Each account read of this row, for the account pool editor (one read serves both). */
	onAccounts: (providerId: string, result: ProviderAccountsResult | null) => void;
}) {
	const t = useT();
	const regionId = useId();
	const [expanded, setExpanded] = useState(false);
	// A subscription sign-in can hold several accounts (stock lists them for OAuth providers).
	const accounts = provider.authenticated && provider.authKind === "oauth" && provider.loginAvailable;
	const state = useProviderAccounts(provider.id, accounts && sidecarReady, revision);
	useEffect(() => onAccounts(provider.id, state.result), [onAccounts, provider.id, state.result]);
	const count = state.result?.accounts.length;
	const summary = !accounts
		? undefined
		: state.error && !expanded
			? state.error.message
			: count === undefined
				? undefined
				: count === 1
					? t("providers.accounts.countOne")
					: t("providers.accounts.count", { count });
	return (
		<ProviderItem
			busyProvider={busyProvider}
			config={config}
			disclosure={
				accounts ? { expanded, onToggle: () => setExpanded(open => !open), controls: regionId } : undefined
			}
			handlers={handlers}
			login={login}
			provider={provider}
			sidecarReady={sidecarReady}
			summary={summary}
		>
			{accounts
				? expanded && (
						<ProviderAccounts
							adding={login.state.running}
							id={regionId}
							onAdd={() => void login.start(provider.id)}
							onChanged={onChanged}
							provider={provider}
							sidecarReady={sidecarReady}
							state={state}
						/>
					)
				: undefined}
		</ProviderItem>
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
					<Button icon={<Plus />} onClick={() => openProviderConfig()} size="sm" variant="secondary">
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
								? t("providerList.noModels")
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
									leading={
										provider === undefined ? (
											<CircleDashed aria-hidden className="text-(--sc-warning)" />
										) : (
											<Server aria-hidden />
										)
									}
									meta={busyProvider === config.id ? <Spinner size="sm" /> : undefined}
									onClick={() => onEdit(config)}
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
	accountPolicies,
	modelSettings,
}: {
	pollMs?: number;
	accountPolicies?: ReactNode;
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

	const onConnected = useCallback(
		async (providerId: string) => {
			await load(true);
			setAccountsRevision(revision => revision + 1);
			const name = providers.find(provider => provider.id === providerId)?.name ?? providerId;
			toast({ variant: "success", message: t("providers.loginSuccess", { provider: name }) });
		},
		[load, providers, t],
	);
	const login = useProviderLogin(onConnected);

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
					onCancel={closeProviderForm}
					onSaved={() => {
						closeProviderForm();
						void load();
					}}
				/>
			</SettingsSection>
		);
	}

	const discoveryErrors = providerDiscoveryErrors(discoveryStates, t("providers.discoveryUnavailable"));
	const connected = groupProviders(providers).connected;
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
						disabled={!catalog.sidecarReady || catalog.loading}
						icon={catalog.loading ? <Spinner inheritColor size="sm" /> : <RefreshCw />}
						label={catalog.sidecarReady ? t("common.refresh") : t("providers.notConnected")}
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
					<ul aria-label={t("providerList.section.connected")}>
						{connected.map(provider => (
							<ConnectedProvider
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
							/>
						))}
					</ul>
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
						<ProviderList
							autoFocusSearch={pickerOpen === true}
							available
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
			{accountPolicies}
			<AccountPoolsEditor
				providers={connected.map(provider => ({ provider, result: accountResults[provider.id] ?? null }))}
				sidecarReady={catalog.sidecarReady}
			/>
			{modelSettings}
			<CustomEndpoints
				busyProvider={busyProvider}
				catalog={catalog}
				onDelete={setPendingDelete}
				onEdit={config => openProviderConfig(config)}
			/>
		</>
	);
}
