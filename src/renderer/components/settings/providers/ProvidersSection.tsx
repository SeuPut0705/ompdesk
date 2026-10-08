/**
 * Settings › Models & providers — the provider part. Embedded by the Settings
 * page (which renders the page heading); no modal, no outer padding.
 * Search, connected first, inline sign-in (OAuth or API key), every stored
 * account of a connected subscription (ProviderAccounts) and an inline form
 * for custom endpoints (`ui.providerForm`, opened by `openProviderConfig`).
 */

import { FileCode2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ProviderInfo } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Banner, Button, ConfirmDialog, IconButton, Spinner } from "../../common";
import { CustomProviderForm } from "./CustomProviderForm";
import { ProviderAccounts } from "./ProviderAccounts";
import { ProviderList, useProviderCatalog } from "./ProviderList";
import { useProviderLogin } from "./ProviderLogin";
import { providerDiscoveryErrors } from "./provider-catalog";

export function ProvidersSection({ pollMs = 2_500 }: { pollMs?: number }) {
	const t = useT();
	const tabRpc = useTabRpc();
	const catalog = useProviderCatalog({ pollMs });
	const discoveryStates = useModelStore(state => state.discoveryStates);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const providerForm = useUiStore(state => state.providerForm);
	const openProviderConfig = useUiStore(state => state.openProviderConfig);
	const closeProviderForm = useUiStore(state => state.closeProviderForm);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);
	const [pendingLogout, setPendingLogout] = useState<ProviderInfo | null>(null);
	const [pendingDelete, setPendingDelete] = useState<CustomProviderView | null>(null);
	/** Bumped after any sign-in or sign-out here: the account lists read again. */
	const [accountsRevision, setAccountsRevision] = useState(0);
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
			await window.omp.models.deleteProvider(config.id);
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

	if (providerForm) {
		return (
			<CustomProviderForm
				editing={providerForm.edit}
				existing={catalog.customConfigs}
				key={providerForm.edit?.id ?? "new"}
				onCancel={closeProviderForm}
				onSaved={() => {
					closeProviderForm();
					void load();
				}}
			/>
		);
	}

	const discoveryErrors = providerDiscoveryErrors(discoveryStates, t("providers.discoveryUnavailable"));

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-muted)">{t("providerList.intro")}</p>
				<Button icon={<Plus />} onClick={() => openProviderConfig()} size="sm" variant="secondary">
					{t("providerList.addCustom")}
				</Button>
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
				<IconButton
					disabled={!catalog.sidecarReady || catalog.loading}
					icon={catalog.loading ? <Spinner inheritColor size="sm" /> : <RefreshCw />}
					label={catalog.sidecarReady ? t("providers.refresh") : t("providers.notConnected")}
					onClick={() => void load(true)}
					size="sm"
				/>
			</div>

			{catalog.configError && (
				<Banner live variant="danger">
					{catalog.configError}
				</Banner>
			)}
			{catalog.error && (
				<Banner
					actions={
						<Button
							disabled={!catalog.sidecarReady}
							onClick={() => void load(true)}
							size="sm"
							variant="secondary"
						>
							{t("providerCfg.list.retry")}
						</Button>
					}
					live
					title={providers.length > 0 ? t("providers.stale") : t("providers.loadFailed")}
					variant="danger"
				>
					{catalog.error}
				</Banner>
			)}
			{discoveryErrors.length > 0 && (
				<Banner variant="warning">{t("providers.discoveryFailed", { details: discoveryErrors.join("; ") })}</Banner>
			)}
			{catalog.refreshPending && <Banner variant="info">{t("providers.refreshPending")}</Banner>}

			<ProviderList
				busyProvider={busyProvider}
				catalog={catalog}
				login={login}
				onAddCustom={() => openProviderConfig()}
				onDeleteConfig={setPendingDelete}
				onEditConfig={config => openProviderConfig(config)}
				onLogout={setPendingLogout}
				renderAccounts={provider =>
					provider.authenticated && provider.authKind === "oauth" && provider.loginAvailable ? (
						<ProviderAccounts
							adding={login.state.running}
							onAdd={() => void login.start(provider.id)}
							onChanged={() => load(true)}
							provider={provider}
							revision={accountsRevision}
							sidecarReady={catalog.sidecarReady}
						/>
					) : null
				}
			/>

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
		</div>
	);
}
