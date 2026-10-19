import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomProviderOptions, CustomProviderView } from "../../../../shared/ipc-types";
import type { ProviderInfo, ProvidersResult } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";

type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Why a models.yml entry has no row in the catalog. Stock lists a provider's
 * models only once it can authenticate them (`auth: apiKey` is its default),
 * so an entry with models and no key is waiting for one, not empty.
 */
export function unlistedCustomReason(config: CustomProviderView, t: TFn): string {
	if (config.models.length === 0) return t("providerList.noModels");
	if (!config.hasApiKey && (config.auth ?? "apiKey") === "apiKey") return t("providerList.needsKey");
	return t("providerList.notLoaded");
}

export interface ProviderCatalog {
	providers: ProviderInfo[];
	customConfigs: CustomProviderView[];
	options: CustomProviderOptions | null;
	loading: boolean;
	/** Provider read failed (the list may still show the last good catalog). */
	error: string | null;
	/** models.yml could not be read. */
	configError: string | null;
	refreshPending: boolean;
	sidecarReady: boolean;
	/** Sign-in can start: the tab's omp is ready or still starting (its commands wait for it). */
	loginReady: boolean;
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
	const status = useSessionStore(state => state.status);
	const sidecarReady = status === "ready";
	// A command for a starting tab is held until its omp is ready, so a sign-in can be asked for already.
	const loginReady = sidecarReady || status === "starting";
	const providers = useModelStore(state => state.providers);
	const refreshPending = useModelStore(state => state.catalogRefreshPending);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const [customConfigs, setCustomConfigs] = useState<CustomProviderView[]>([]);
	const [options, setOptions] = useState<CustomProviderOptions | null>(null);
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
					setCustomConfigs(configsResult.value.providers);
					setOptions(configsResult.value.options);
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
		setOptions(null);
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

	return {
		providers,
		customConfigs,
		options,
		loading,
		error,
		configError,
		refreshPending,
		sidecarReady,
		loginReady,
		load,
	};
}

export function authLabel(provider: ProviderInfo, t: TFn): string {
	if (provider.authKind === "oauth") return t("providers.badge.oauth");
	if (provider.authKind === "env") return t("providers.badge.env");
	return t("providers.badge.apikey");
}

export interface RowHandlers {
	onConnect: (provider: ProviderInfo) => void;
	onLogout?: (provider: ProviderInfo) => void;
}
