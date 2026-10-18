/**
 * "Add a provider" in Settings › Models & providers: every provider that can sign in and is not
 * connected yet, as a dense grid of brand mark + name, sorted by company, searchable. A click
 * starts the same stock sign-in as before (its inline panel renders in ProvidersSection). A
 * provider omp lists but cannot sign in (nothing to connect: a models.yml endpoint, an env
 * key) is not offered here; custom endpoints have their own section.
 */

import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { Button, EmptyState, SearchField, Spinner } from "../../common";
import type { ProviderCatalog } from "./ProviderList";
import type { ProviderLogin } from "./ProviderLogin";
import { ProviderMark } from "./ProviderMark";
import { providerMatches } from "./provider-catalog";
import { sortProvidersByCompany } from "./provider-marks";

export function ProviderPicker({
	catalog,
	login,
	busyProvider = null,
	onAddCustom,
	autoFocusSearch = false,
}: {
	catalog: ProviderCatalog;
	login: ProviderLogin;
	busyProvider?: string | null;
	/** Offered when a search finds nothing. */
	onAddCustom?: () => void;
	autoFocusSearch?: boolean;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const { providers, loading, sidecarReady } = catalog;
	const searching = query.trim().length > 0;
	const available = sortProvidersByCompany(
		providers.filter(
			provider => !provider.authenticated && provider.loginAvailable && providerMatches(provider, query),
		),
	);
	return (
		<div className="flex flex-col gap-1">
			<SearchField
				autoFocus={autoFocusSearch}
				onKeyDown={event => {
					// A search that narrows to one provider: Enter signs in to it.
					const only = available.length === 1 ? available[0] : undefined;
					if (event.key === "Enter" && !isImeKeyEvent(event) && only && searching && sidecarReady)
						void login.start(only.id);
				}}
				label={t("providerList.search")}
				onValueChange={setQuery}
				placeholder={t("providerList.searchPlaceholder")}
				value={query}
			/>
			{loading && providers.length === 0 ? (
				<div className="flex justify-center py-6">
					<Spinner label={t("providerList.loading")} />
				</div>
			) : available.length === 0 ? (
				<EmptyState
					actions={
						onAddCustom && (
							<Button onClick={onAddCustom} size="sm" variant="secondary">
								{t("providerList.addCustom")}
							</Button>
						)
					}
					className="py-6"
					description={searching ? t("providerList.noMatchHint") : undefined}
					size="sm"
					title={searching ? t("providerList.noMatch", { query: query.trim() }) : t("providers.picker.none")}
				/>
			) : (
				<ul
					aria-label={t("providers.add")}
					className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-1 gap-y-0.5"
					data-provider-picker
				>
					{available.map(provider => {
						const busy =
							busyProvider === provider.id || (login.state.running && login.state.providerId === provider.id);
						return (
							<li key={provider.id}>
								<button
									aria-label={t("providers.picker.connect", { provider: provider.name })}
									className="flex h-8 w-full items-center gap-2 rounded-(--sc-radius-md) px-2 text-left text-sc-md text-(--sc-text) outline-none hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50"
									data-provider-connect={provider.id}
									disabled={!sidecarReady || busy}
									onClick={() => void login.start(provider.id)}
									title={sidecarReady ? undefined : t("providers.notConnected")}
									type="button"
								>
									<ProviderMark provider={provider} />
									<span className="min-w-0 flex-1 truncate">{provider.name}</span>
									{busy && <Spinner size="sm" />}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
