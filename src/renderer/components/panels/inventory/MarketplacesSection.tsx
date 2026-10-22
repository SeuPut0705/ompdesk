import { useTabRpc } from "../../../lib/tab-rpc";
/**
 * Interactive Marketplaces tab body: add-marketplace form plus per-marketplace
 * rows with catalog refresh, inline-confirmed removal, and a lazy-expanded
 * available-plugins list with install/upgrade/uninstall row actions.
 *
 * Every mutation rides marketplace_action and refetches only after any required
 * origin-tab restart settles. No optimistic derivation of plugin counts or
 * install state, and no dependency on available_commands_update ordering.
 */

import { Check, ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useId, useState } from "react";
import type { RpcMarketplaceInfo, RpcMarketplacePluginInfo } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { openExternal } from "../../../lib/open-external";
import {
	capturePluginActivationOrigin,
	handlePluginActivation,
	isPluginActivationOriginActive,
} from "../../../lib/plugin-activation";
import { Badge, Button, IconButton, InlineNotice, Input, LinkButton, Spinner } from "../../common";
import { shortenSource } from "../inventory-utils";
import { availablePluginActions, classifyMarketplaceSource, type MarketplacePluginAction } from "./marketplace-source";
import { listAvailablePlugins, mutationError } from "./rpc-result";

// ============================================================================
// Add marketplace form
// ============================================================================

export function AddMarketplaceForm({ onAdded, ready = true }: { onAdded: () => Promise<void>; ready?: boolean }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [invalid, setInvalid] = useState(false);
	const hintId = useId();

	const submit = async (): Promise<void> => {
		if (!ready) return;
		const trimmed = source.trim();
		// Client-side parity with the agent's classifySource: a bare name is
		// rejected inline before the RPC fires (same rule order, same verdict).
		if (classifyMarketplaceSource(trimmed) === null) {
			setInvalid(true);
			return;
		}
		setBusy(true);
		setError(null);
		setInvalid(false);
		try {
			const res = await tabRpc.marketplaceAction({ action: "add", source: trimmed });
			const failure = mutationError(res, t("marketplace.unknownError"));
			if (failure !== null) {
				setError(failure);
				return;
			}
			setSource("");
			await onAdded();
		} catch (cause) {
			setError(String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-end gap-2">
				<div className="min-w-0 flex-1">
					<Input
						aria-describedby={hintId}
						aria-label={t("marketplace.addTitle")}
						disabled={busy || !ready}
						label={t("marketplace.addTitle")}
						mono
						onChange={event => {
							setSource(event.target.value);
							setError(null);
							setInvalid(false);
						}}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") void submit();
						}}
						placeholder={t("marketplace.sourcePlaceholder")}
						spellCheck={false}
						type="text"
						value={source}
					/>
				</div>
				<Button
					disabled={source.trim() === "" || busy || !ready}
					icon={<Plus />}
					loading={busy}
					onClick={() => void submit()}
					title={!ready ? t("invPanel.notConnected") : undefined}
				>
					{t("marketplace.add")}
				</Button>
			</div>
			<p className="text-sc-sm text-(--sc-text-muted)" id={hintId}>
				{t("marketplace.sourceHint")}
			</p>
			{invalid && (
				<InlineNotice
					copyLabel={t("marketplace.copyError")}
					live
					title={t("marketplace.sourceInvalid")}
					tone="danger"
				/>
			)}
			{error && (
				<InlineNotice
					copyLabel={t("marketplace.copyError")}
					detail={error}
					live
					title={t("marketplace.addFailed")}
					tone="danger"
				/>
			)}
		</div>
	);
}

// ============================================================================
// Available plugin row
// ============================================================================

function AvailablePluginRow({
	plugin,
	busyAction,
	anyBusy,
	confirmingInstall,
	onAction,
	onConfirmInstall,
	onCancelInstall,
}: {
	plugin: RpcMarketplacePluginInfo;
	/** This row's in-flight action (its button shows the spinner). */
	busyAction: MarketplacePluginAction | null;
	/** Another row's action is in flight — one mutation per marketplace at a time. */
	anyBusy: boolean;
	/** Install clicked but not yet confirmed — the Install button swaps to confirm/cancel. */
	confirmingInstall: boolean;
	onAction: (pluginName: string, action: MarketplacePluginAction) => void;
	onConfirmInstall: (pluginName: string) => void;
	onCancelInstall: () => void;
}) {
	const t = useT();
	const repository = plugin.repository;
	const homepage = plugin.homepage;
	return (
		<div className="flex items-center gap-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-sc-md font-medium text-(--sc-text)">{plugin.name}</span>
					{plugin.version && (
						<span className="text-sc-xs tabular-nums text-(--sc-text-muted)">v{plugin.version}</span>
					)}
					{plugin.installed && <Badge variant="success">{t("marketplace.installed")}</Badge>}
				</div>
				{plugin.description && <span className="text-sc-sm text-(--sc-text-muted)">{plugin.description}</span>}
				{confirmingInstall && (
					<span className="text-sc-sm text-(--sc-warning)" role="status">
						{t("marketplace.installConfirmHint")}
					</span>
				)}
				{(plugin.author ||
					plugin.license ||
					plugin.category ||
					repository ||
					homepage ||
					(plugin.tags?.length ?? 0) > 0) && (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sc-xs text-(--sc-text-muted)">
						{plugin.author && <span>{plugin.author}</span>}
						{plugin.license && <span>{plugin.license}</span>}
						{plugin.category && <span>{plugin.category}</span>}
						{plugin.tags?.map(tag => (
							<span key={tag}>#{tag}</span>
						))}
						{repository && (
							<LinkButton onClick={() => openExternal(repository)} title={repository}>
								{t("marketplace.repository")}
							</LinkButton>
						)}
						{homepage && (
							<LinkButton onClick={() => openExternal(homepage)} title={homepage}>
								{t("marketplace.homepage")}
							</LinkButton>
						)}
					</div>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{confirmingInstall ? (
					<span className="flex shrink-0 items-center gap-0.5">
						<IconButton
							disabled={anyBusy}
							icon={<Check />}
							label={t("marketplace.installConfirm")}
							onClick={() => onConfirmInstall(plugin.name)}
							size="sm"
							variant="primary"
						/>
						<IconButton
							disabled={anyBusy}
							icon={<X />}
							label={t("common.cancel")}
							onClick={onCancelInstall}
							size="sm"
						/>
					</span>
				) : (
					availablePluginActions(plugin.installed).map(action => (
						<Button
							className={action === "uninstall" ? "text-(--sc-danger)" : undefined}
							disabled={anyBusy}
							key={action}
							loading={busyAction === action}
							onClick={() => onAction(plugin.name, action)}
							size="sm"
							variant={action === "install" ? "secondary" : "ghost"}
						>
							{t(`marketplace.${action}`)}
						</Button>
					))
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Marketplace card
// ============================================================================

export function MarketplaceCard({
	marketplace,
	reload,
	ready = true,
}: {
	marketplace: RpcMarketplaceInfo;
	/** Refetch get_marketplaces (card data: name, source, plugin count, cache note). */
	reload: () => Promise<void>;
	ready?: boolean;
}) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [available, setAvailable] = useState<RpcMarketplacePluginInfo[] | null>(null);
	const [listLoading, setListLoading] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	const [busyAction, setBusyAction] = useState<"update" | "remove" | null>(null);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [cardError, setCardError] = useState<string | null>(null);
	const [pluginBusy, setPluginBusy] = useState<{ name: string; action: MarketplacePluginAction } | null>(null);
	const [pluginErrors, setPluginErrors] = useState<Readonly<Record<string, string>>>({});
	const [confirmInstall, setConfirmInstall] = useState<string | null>(null);

	/** list_available — lazy on first expand, then cached in component state. */
	const fetchAvailable = useCallback(async (): Promise<void> => {
		if (!ready) return;
		setListLoading(true);
		setListError(null);
		try {
			const res = await tabRpc.marketplaceAction({
				action: "list_available",
				marketplace: marketplace.name,
			});
			const result = listAvailablePlugins(res, t("marketplace.unknownError"));
			if (result.ok) {
				setAvailable(result.plugins);
			} else {
				setListError(result.error);
			}
		} catch (cause) {
			setListError(String(cause));
		} finally {
			setListLoading(false);
		}
	}, [marketplace.name, ready, t, tabRpc.marketplaceAction]);

	const toggleExpanded = (): void => {
		if (!ready) return;
		const next = !expanded;
		setExpanded(next);
		if (next && available === null && !listLoading) void fetchAvailable();
	};

	/** Catalog refresh — long-running (clone/fetch), spinner for the duration. */
	const refreshCatalog = async (): Promise<void> => {
		if (!ready) return;
		setBusyAction("update");
		setCardError(null);
		try {
			const res = await tabRpc.marketplaceAction({ action: "update", marketplace: marketplace.name });
			const failure = mutationError(res, t("marketplace.unknownError"));
			if (failure !== null) {
				setCardError(failure);
				return;
			}
			// The catalog changed — refresh both the card (count/cache note) and,
			// when expanded, the available list (versions may have moved).
			if (expanded) await fetchAvailable();
			await reload();
		} catch (cause) {
			setCardError(String(cause));
		} finally {
			setBusyAction(null);
		}
	};

	const removeMarketplace = async (): Promise<void> => {
		if (!ready) return;
		setBusyAction("remove");
		setCardError(null);
		try {
			const res = await tabRpc.marketplaceAction({ action: "remove", marketplace: marketplace.name });
			const failure = mutationError(res, t("marketplace.unknownError"));
			if (failure !== null) {
				setCardError(failure);
				setConfirmingRemove(false);
				return;
			}
			await reload();
		} catch (cause) {
			setCardError(String(cause));
			setConfirmingRemove(false);
		} finally {
			setBusyAction(null);
		}
	};

	const runPluginAction = (pluginName: string, action: MarketplacePluginAction): void => {
		if (!ready) return;
		// The catalog wire carries no omp manifest, so the GUI cannot know
		// pre-install whether a plugin ships executable entry points — confirm
		// every install (metadata is visible on the row).
		if (action === "install") {
			setConfirmInstall(pluginName);
			return;
		}
		void executePluginAction(pluginName, action);
	};

	const executePluginAction = async (pluginName: string, action: MarketplacePluginAction): Promise<void> => {
		if (!ready) return;
		const origin = capturePluginActivationOrigin();
		if (!origin) {
			setPluginErrors(prev => ({ ...prev, [pluginName]: t("pluginActivation.routePending") }));
			return;
		}
		setConfirmInstall(prev => (prev === pluginName ? null : prev));
		setPluginBusy({ name: pluginName, action });
		setPluginErrors(prev => {
			if (!(pluginName in prev)) return prev;
			const rest = { ...prev };
			delete rest[pluginName];
			return rest;
		});
		try {
			const res = await tabRpc.marketplaceAction({
				action,
				marketplace: marketplace.name,
				plugin: pluginName,
			});
			const failure = mutationError(res, t("marketplace.unknownError"));
			if (failure !== null) {
				if (isPluginActivationOriginActive(origin)) {
					setPluginErrors(prev => ({ ...prev, [pluginName]: failure }));
				}
				return;
			}
			const data = res.data as { activation?: string } | undefined;
			await handlePluginActivation(
				data?.activation,
				{
					pluginId: `${pluginName}@${marketplace.name}`,
					expected: action === "uninstall" ? "disabled" : "enabled",
				},
				origin,
			);
			if (!isPluginActivationOriginActive(origin)) return;
			await fetchAvailable();
			await reload();
		} catch (cause) {
			if (isPluginActivationOriginActive(origin)) {
				setPluginErrors(prev => ({ ...prev, [pluginName]: String(cause) }));
			}
		} finally {
			setPluginBusy(null);
		}
	};

	const actionsDisabled = busyAction !== null || !ready;

	return (
		<div className="py-1">
			<div className="flex items-center gap-2 py-2">
				<IconButton
					aria-expanded={expanded}
					disabled={!ready}
					icon={expanded ? <ChevronDown /> : <ChevronRight />}
					label={t("marketplace.browse")}
					onClick={toggleExpanded}
					size="sm"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-sc-md font-medium text-(--sc-text)">{marketplace.name}</span>
						{marketplace.pluginCount !== undefined ? (
							<Badge variant="default">
								{t("invPanel.marketplaces.pluginCount", { count: marketplace.pluginCount })}
							</Badge>
						) : (
							<Badge variant="muted">{t("invPanel.marketplaces.notFetched")}</Badge>
						)}
						{/* Catalogs are cache-backed — the note is always visible. */}
						<span className="text-sc-xs text-(--sc-text-muted)">{t("marketplace.cacheNote")}</span>
					</div>
					<span className="truncate font-mono text-sc-xs text-(--sc-text-muted)" title={marketplace.source}>
						{shortenSource(marketplace.source)}
					</span>
				</div>
				<IconButton
					disabled={actionsDisabled}
					icon={<RefreshCw />}
					label={!ready ? t("invPanel.notConnected") : t("marketplace.refresh")}
					loading={busyAction === "update"}
					onClick={() => void refreshCatalog()}
					size="sm"
				/>
				{confirmingRemove ? (
					<span className="flex shrink-0 items-center gap-0.5">
						<IconButton
							disabled={actionsDisabled}
							icon={<Check />}
							label={t("marketplace.removeConfirm")}
							loading={busyAction === "remove"}
							onClick={() => void removeMarketplace()}
							size="sm"
							variant="danger"
						/>
						<IconButton
							disabled={actionsDisabled}
							icon={<X />}
							label={t("common.cancel")}
							onClick={() => setConfirmingRemove(false)}
							size="sm"
						/>
					</span>
				) : (
					<IconButton
						disabled={actionsDisabled}
						icon={<Trash2 />}
						label={t("marketplace.remove")}
						onClick={() => setConfirmingRemove(true)}
						size="sm"
					/>
				)}
			</div>
			{cardError && (
				<InlineNotice
					className="mb-2"
					copyLabel={t("marketplace.copyError")}
					detail={cardError}
					live
					title={t("marketplace.actionFailed")}
					tone="danger"
				/>
			)}
			{expanded && (
				<div className="mb-2 ml-9 flex flex-col gap-2">
					{available === null && listLoading ? (
						<div className="flex items-center justify-center py-4">
							<Spinner label={t("common.loading")} />
						</div>
					) : available === null && listError !== null ? (
						<>
							<InlineNotice
								copyLabel={t("marketplace.copyError")}
								detail={listError}
								live
								title={t("marketplace.listFailed")}
								tone="danger"
							/>
							<div>
								<Button
									disabled={!ready}
									icon={<RefreshCw />}
									onClick={() => void fetchAvailable()}
									size="sm"
									title={!ready ? t("invPanel.notConnected") : undefined}
								>
									{t("common.retry")}
								</Button>
							</div>
						</>
					) : available !== null && available.length === 0 ? (
						<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("marketplace.availableEmpty")}</p>
					) : (
						<>
							<div className="divide-y divide-(--sc-divider) border-y border-(--sc-divider)">
								{(available ?? []).map(plugin => (
									<div key={plugin.name}>
										<AvailablePluginRow
											anyBusy={pluginBusy !== null || !ready}
											busyAction={pluginBusy?.name === plugin.name ? pluginBusy.action : null}
											confirmingInstall={confirmInstall === plugin.name}
											onAction={runPluginAction}
											onCancelInstall={() => setConfirmInstall(null)}
											onConfirmInstall={name => void executePluginAction(name, "install")}
											plugin={plugin}
										/>
										{pluginErrors[plugin.name] && (
											<InlineNotice
												className="mb-2.5"
												copyLabel={t("marketplace.copyError")}
												detail={pluginErrors[plugin.name]}
												live
												title={t("marketplace.actionFailed")}
												tone="danger"
											/>
										)}
									</div>
								))}
							</div>
							{listLoading && <Spinner label={t("common.loading")} size="sm" />}
							{listError && (
								<InlineNotice
									copyLabel={t("marketplace.copyError")}
									detail={listError}
									live
									title={t("marketplace.listFailed")}
									tone="danger"
								/>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
