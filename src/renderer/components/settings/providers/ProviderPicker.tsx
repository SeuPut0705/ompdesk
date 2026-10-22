/**
 * "Add a provider" in Settings › Models & providers: every provider that can sign in and is not
 * connected yet, as a dense grid of brand mark + name, sorted by company, searchable. A click
 * starts the same stock sign-in as before (its inline panel renders in ProvidersSection). A
 * provider omp lists but cannot sign in (nothing to connect: a models.yml endpoint, an env
 * key) is not offered here; custom endpoints have their own section.
 */

import { useState } from "react";
import type { ProviderInfo } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { Badge, Button, EmptyState, SearchField, SkeletonRows, Spinner } from "../../common";
import type { ProviderCatalog } from "./ProviderList";
import type { ProviderLogin } from "./ProviderLogin";
import { ProviderMark } from "./ProviderMark";
import { FEATURED_PROVIDERS, providerMatches } from "./provider-catalog";
import { sortProvidersByCompany } from "./provider-marks";

export function ProviderPicker({
	catalog,
	login,
	busyProvider = null,
	onAddCustom,
	autoFocusSearch = false,
	showConnectedFeatured = false,
	headingLevel = 4,
}: {
	catalog: ProviderCatalog;
	login: ProviderLogin;
	busyProvider?: string | null;
	/** Offered when a search finds nothing. */
	onAddCustom?: () => void;
	autoFocusSearch?: boolean;
	/** First run lists a connected featured provider as connected; Settings already lists those above. */
	showConnectedFeatured?: boolean;
	/** The group headings' level: one under the heading that holds the picker (first run's h1, a Settings section's h3). */
	headingLevel?: 2 | 4;
}) {
	const Heading = headingLevel === 2 ? "h2" : "h4";
	const t = useT();
	const [query, setQuery] = useState("");
	const { providers, loading, loginReady } = catalog;
	const searching = query.trim().length > 0;
	const featured = searching ? [] : featuredCards(providers, showConnectedFeatured);
	const featuredIds = new Set(featured.flatMap(card => [card.def.id, card.def.apiKeyId ?? ""]));
	const available = sortProvidersByCompany(
		providers.filter(
			provider =>
				!provider.authenticated &&
				provider.loginAvailable &&
				!featuredIds.has(provider.id) &&
				providerMatches(provider, query),
		),
	);
	const busyId = (id: string) => busyProvider === id || (login.state.running && login.state.providerId === id);
	return (
		<div className="flex flex-col gap-1">
			<SearchField
				autoFocus={autoFocusSearch}
				onKeyDown={event => {
					// A search that narrows to one provider: Enter signs in to it.
					const only = available.length === 1 ? available[0] : undefined;
					if (event.key === "Enter" && !isImeKeyEvent(event) && only && searching && loginReady)
						void login.start(only.id);
				}}
				label={t("providerList.search")}
				onValueChange={setQuery}
				placeholder={t("providerList.searchPlaceholder")}
				value={query}
			/>
			{loading && providers.length === 0 ? (
				<SkeletonRows className="py-2" label={t("providerList.loading")} widths={[60, 44, 70, 52]} />
			) : available.length === 0 && featured.length === 0 ? (
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
				<>
					{featured.length > 0 && (
						<section
							aria-label={t("providers.featured.title")}
							className="mt-3 mb-2 flex flex-col gap-1.5"
							data-featured-providers
						>
							<Heading className="px-2 text-sc-xs font-semibold tracking-(--sc-tracking-tight) text-(--sc-text-muted) uppercase">
								{t("providers.featured.title")}
							</Heading>
							<ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
								{featured.map(card => (
									<FeaturedCard
										busyId={busyId}
										card={card}
										key={card.def.id}
										login={login}
										loginReady={loginReady}
									/>
								))}
							</ul>
						</section>
					)}
					{available.length > 0 && !searching && featured.length > 0 && (
						<Heading className="px-2 pt-1 text-sc-xs font-semibold tracking-(--sc-tracking-tight) text-(--sc-text-muted) uppercase">
							{t("providers.other.title")}
						</Heading>
					)}
					{available.length > 0 && (
						<ul
							aria-label={t("providers.add")}
							className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-1 gap-y-0.5"
							data-provider-picker
						>
							{available.map(provider => {
								const busy =
									busyProvider === provider.id ||
									(login.state.running && login.state.providerId === provider.id);
								return (
									<li key={provider.id}>
										<button
											aria-label={t("providers.picker.connect", { provider: provider.name })}
											className="flex h-8 w-full items-center gap-2 rounded-(--sc-radius-md) px-2 text-left text-sc-md text-(--sc-text) hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50"
											data-provider-connect={provider.id}
											disabled={!loginReady || busy}
											onClick={() => void login.start(provider.id)}
											title={loginReady ? undefined : t("providers.notConnected")}
											type="button"
										>
											<ProviderMark provider={provider} />
											<span className="min-w-0 flex-1 truncate">{provider.name}</span>
											{busy && <Spinner size="sm" spin />}
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
		</div>
	);
}

interface FeaturedCardData {
	def: (typeof FEATURED_PROVIDERS)[number];
	/** The stock login the card's main action runs. */
	startId: string;
	/** The stock API-key login offered as the second action, when the card has both. */
	apiKeyId: string | null;
	connected: boolean;
	mark: ProviderInfo;
}

/** The featured providers this catalog can sign in to (or already has), in the featured order. */
function featuredCards(providers: readonly ProviderInfo[], showConnected: boolean): FeaturedCardData[] {
	const byId = new Map(providers.map(provider => [provider.id, provider]));
	const cards: FeaturedCardData[] = [];
	for (const def of FEATURED_PROVIDERS) {
		const primary = byId.get(def.id);
		const secondary = def.apiKeyId ? byId.get(def.apiKeyId) : undefined;
		const connected = primary?.authenticated === true || secondary?.authenticated === true;
		if (connected ? !showConnected : false) continue;
		const startable = primary?.loginAvailable ? primary : secondary?.loginAvailable ? secondary : undefined;
		if (!connected && !startable) continue;
		const mark = primary ?? secondary;
		if (!mark) continue;
		cards.push({
			def,
			startId: startable?.id ?? mark.id,
			apiKeyId: startable === primary && secondary?.loginAvailable ? secondary.id : null,
			connected,
			mark,
		});
	}
	return cards;
}

function FeaturedCard({
	card,
	login,
	busyId,
	loginReady,
}: {
	card: FeaturedCardData;
	login: ProviderLogin;
	busyId: (id: string) => boolean;
	loginReady: boolean;
}) {
	const t = useT();
	const { def, startId, apiKeyId, connected, mark } = card;
	const subscription = def.kind === "subscription" && startId === def.id;
	const busy = busyId(startId);
	const frame = "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left";
	return (
		<li
			className="flex flex-col rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1)"
			data-featured-provider={def.id}
		>
			{connected ? (
				<div className={frame} data-provider-connected={def.id}>
					<ProviderMark provider={mark} />
					<span className="min-w-0 flex-1 truncate text-sc-md font-medium text-(--sc-text)">{def.label}</span>
					<Badge dot variant="success">
						{t("providerList.connected")}
					</Badge>
				</div>
			) : (
				<button
					aria-label={t("providers.picker.connect", { provider: def.label })}
					className={`${frame} rounded-(--sc-radius-lg) text-(--sc-text) hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50`}
					data-provider-connect={startId}
					disabled={!loginReady || busy}
					onClick={() => void login.start(startId)}
					title={loginReady ? undefined : t("providers.notConnected")}
					type="button"
				>
					<ProviderMark provider={mark} />
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-sc-md font-medium">{def.label}</span>
						<span className="truncate text-sc-sm text-(--sc-text-muted)">
							{subscription ? t("providers.featured.subscription") : t("providers.featured.apiKey")}
						</span>
					</span>
					{busy ? (
						<Spinner size="sm" spin />
					) : (
						<span className="shrink-0 text-sc-sm font-medium text-(--sc-accent)">
							{subscription ? t("providers.featured.signIn") : t("providers.featured.connect")}
						</span>
					)}
				</button>
			)}
			{!connected && apiKeyId && (
				<button
					className="mt-auto flex min-h-11 w-full items-center rounded-b-(--sc-radius-lg) border-t border-(--sc-border-subtle) py-1 pr-3 pl-11 text-left text-sc-sm text-(--sc-text-muted) underline-offset-2 hover:bg-(--sc-hover) hover:text-(--sc-text) hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50"
					data-provider-connect={apiKeyId}
					disabled={!loginReady || busyId(apiKeyId)}
					onClick={() => void login.start(apiKeyId)}
					type="button"
				>
					{t("providers.featured.apiKeyAction")}
				</button>
			)}
		</li>
	);
}
