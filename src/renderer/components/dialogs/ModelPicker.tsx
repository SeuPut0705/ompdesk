/**
 * Model picker (Picker container): search, models grouped by provider with
 * connected providers first, current model checked. Picking switches the
 * session (`set_model`) and saves the pick as the default for new sessions
 * (`modelRoles.default`), the way omp's own `/model` picker does — without it
 * every new session falls back to omp's catalog choice, which can be a keyless
 * on-device model that cannot hold a coding session.
 *
 * Opened with purpose "pool" (from the Modes popover's model-pool tab, which
 * closes first: no overlay opens another), a pick adds the model to the
 * session's model pool instead, checks mark pool members, and closing returns
 * to that tab.
 */

import { Check, Settings2, TriangleAlert } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { LoginProvider, ModelInfo, RpcModelPoolState } from "../../../shared/rpc-types";
import { applyModelInfo, hydrateSession } from "../../hooks/use-rpc-events";
import { useCompactionPoints } from "../../lib/compaction-limits";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { addPoolMember, EMPTY_MODEL_POOL, modelSelector } from "../../lib/model-pool";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, ErrorDetail, Kbd, Modal, SearchField, Spinner } from "../common";
import { persistDefaultModel } from "../onboarding/default-model";
import { CompactsAt } from "../settings/CompactsAt";
import { MIN_SERVING_CONTEXT, modelDisplayName } from "../settings/providers/provider-catalog";

export function ModelPicker() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen);
	const close = useUiStore(state => state.closeModelPicker);
	const purpose = useUiStore(state => state.modelPickerPurpose);
	const openModes = useUiStore(state => state.openModes);
	const pool = useSessionStore(state => state.modelPool);
	const forPool = purpose === "pool";
	const openProviders = useUiStore(state => state.openProviders);
	const availableModels = useModelStore(state => state.availableModels);
	const catalogProviders = useModelStore(state => state.providers);
	const current = useModelStore(state => state.model);
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);
	// Live session usage: models whose window is smaller render with an
	// over-context warning and compact-first on pick (TUI markOverContext parity).
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	// Where each model auto-compacts (stock `/models` preview parity); null on an omp before 18.8.5.
	const compactionPoints = useCompactionPoints(open);

	const [query, setQuery] = useState("");
	const [loginProviders, setLoginProviders] = useState<LoginProvider[]>([]);
	const [switching, setSwitching] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	const requestVersion = useRef(0);

	/** Login flows are the picker's own concern, but the model list is shared
	 * catalog state: it commits through the store's generation guard, so a
	 * `model_catalog_update` that lands mid-read can never be reverted by this
	 * response. `forceRefresh` belongs to the retry path, where the user is
	 * disputing what the list shows. */
	const load = useCallback(
		async (forceRefresh: boolean, failedCopy?: string): Promise<void> => {
			const version = ++requestVersion.current;
			setLoading(true);
			setError(null);
			if (!sidecarReady) {
				setError({ message: t("modelPicker.notConnected") });
				setLoading(false);
				return;
			}
			const [providersResult, modelsResult] = await Promise.allSettled([
				tabRpc.getLoginProviders(),
				refreshAvailableModels(forceRefresh),
			]);
			if (version !== requestVersion.current) return;
			setLoading(false);
			const providersOk = providersResult.status === "fulfilled" && providersResult.value.success;
			if (providersOk) {
				const data = providersResult.value.data as { providers?: LoginProvider[] } | undefined;
				setLoginProviders(data?.providers ?? []);
				return;
			}
			if (modelsResult.status === "fulfilled") return;
			// Models rejected too; the login-providers failure carries the cause.
			const cause = providersResult.status === "rejected" ? providersResult.reason : providersResult.value;
			setError(failedCopy ? { message: failedCopy, cause } : inlineFailure(cause, t("modelPicker.notResponding")));
		},
		[refreshAvailableModels, sidecarReady, t, tabRpc],
	);

	useEffect(() => {
		if (!open) return undefined;
		setQuery("");
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
		void load(false);
		return () => {
			requestVersion.current++;
		};
	}, [open, load]);

	const authByProvider = useMemo(
		() => new Map(loginProviders.map(provider => [provider.id, provider])),
		[loginProviders],
	);
	const nameByProvider = useMemo(() => {
		const map = new Map<string, string>();
		for (const provider of catalogProviders) map.set(provider.id, provider.name);
		for (const provider of loginProviders) map.set(provider.id, provider.name);
		return map;
	}, [catalogProviders, loginProviders]);
	const connected = useCallback(
		(provider: string) =>
			authByProvider.get(provider)?.authenticated ??
			catalogProviders.find(row => row.id === provider)?.authenticated ??
			false,
		[authByProvider, catalogProviders],
	);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = availableModels.filter(
			model =>
				q.length === 0 ||
				model.id.toLowerCase().includes(q) ||
				model.provider.toLowerCase().includes(q) ||
				(nameByProvider.get(model.provider)?.toLowerCase().includes(q) ?? false) ||
				model.name?.toLowerCase().includes(q) ||
				model.description?.toLowerCase().includes(q),
		);
		const map = new Map<string, ModelInfo[]>();
		for (const model of filtered) {
			const list = map.get(model.provider) ?? [];
			list.push(model);
			map.set(model.provider, list);
		}
		// Connected providers first; within each half, by display name.
		return [...map.entries()].sort(
			([a], [b]) =>
				Number(connected(b)) - Number(connected(a)) ||
				(nameByProvider.get(a) ?? a).localeCompare(nameByProvider.get(b) ?? b),
		);
	}, [availableModels, connected, nameByProvider, query]);

	// Flat row order (group order → in-group order) for keyboard navigation.
	const flatOptions = useMemo(
		() =>
			groups.flatMap(([provider, models]) =>
				models.map(model => ({ provider, modelId: model.id, key: `${provider}/${model.id}` })),
			),
		[groups],
	);
	const indexByKey = useMemo(() => new Map(flatOptions.map((option, index) => [option.key, index])), [flatOptions]);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, flatOptions.length - 1)));
	}, [flatOptions.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const isOverContext = (model: ModelInfo): boolean => {
		// Pool members run as fresh subagents: the main context never moves to them.
		if (forPool) return false;
		const tokens = contextUsage?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		return tokens > 0 && contextWindow > 0 && tokens > contextWindow;
	};

	/** Close; a pool pick returns to the Modes popover's pool tab it came from. */
	const dismiss = () => {
		close();
		if (forPool) openModes("pool");
	};

	const addToPool = async (model: ModelInfo) => {
		const current = pool ?? EMPTY_MODEL_POOL;
		const next = addPoolMember(current, { selector: modelSelector(model), name: modelDisplayName(model) });
		if (next === current) {
			dismiss();
			return;
		}
		const response = await tabRpc.setModelPool(next);
		if (!response.success) {
			toastError({ title: t("modelPool.updateFailed"), error: response });
			return;
		}
		(sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore).setState({
			modelPool: response.data as RpcModelPoolState,
		});
		dismiss();
	};

	const select = async (provider: string, modelId: string) => {
		if (!sidecarReady) return;
		const key = `${provider}/${modelId}`;
		setSwitching(key);
		try {
			const target = availableModels.find(m => m.provider === provider && m.id === modelId);
			if (forPool) {
				if (target) await addToPool(target);
				return;
			}
			// TUI parity: picking a model whose context window is smaller than the
			// live session usage compacts with the CURRENT model first, then
			// switches. The row carries the over-context warning before the pick.
			const overContext = target !== undefined && isOverContext(target);
			if (overContext) {
				const compactRes = await tabRpc.compact();
				if (!compactRes.success) {
					toastError({ title: t("modelPicker.compactFailed"), error: compactRes });
					return;
				}
				toast({ variant: "info", message: t("modelPicker.compactedSwitching") });
			}
			const response = await tabRpc.setModel(provider, modelId);
			if (!response.success) {
				toastError({ title: t("modelPicker.failed"), error: response });
				return;
			}
			// The response carries the sidecar's live model. Applying it here covers
			// the switch that emits no model_changed at all — re-picking the current
			// model is a server-side no-op, so the event channel can never heal a
			// stale label.
			if (tabId) applyModelInfo(response.data, tabId);
			// Compaction rewrote the transcript — rehydrate so the chat and the
			// context bar reflect the compacted session, not just the new model.
			if (overContext) await hydrateSession();
			close();
			try {
				await persistDefaultModel(tabRpc, { provider, id: modelId });
			} catch (cause) {
				toastError({ title: t("modelPicker.defaultFailed"), error: cause, variant: "warning" });
			}
		} catch (cause) {
			toastError({ title: t("modelPicker.failed"), error: cause });
		} finally {
			setSwitching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(index => Math.min(index + 1, flatOptions.length - 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(index => Math.max(index - 1, 0));
				break;
			case "Home":
				event.preventDefault();
				setActiveIndex(0);
				break;
			case "End":
				event.preventDefault();
				setActiveIndex(Math.max(0, flatOptions.length - 1));
				break;
			case "Enter": {
				event.preventDefault();
				const option = flatOptions[activeIndex];
				if (option) void select(option.provider, option.modelId);
				break;
			}
		}
	};

	const manageProviders = () => {
		close();
		openProviders();
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && groups.length > 0;

	return (
		<Modal
			ariaLabel={t("modelPicker.searchLabel")}
			bodyClassName="p-0"
			chromeless
			onClose={dismiss}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col">
				<div className="border-b border-(--sc-divider) p-3">
					<SearchField
						aria-activedescendant={flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
						aria-controls={listboxId}
						controlSize="lg"
						label={t("modelPicker.searchLabel")}
						onKeyDown={onKeyDown}
						onValueChange={setQuery}
						placeholder={t("modelPicker.placeholder")}
						ref={inputRef}
						value={query}
					/>
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
							<span className="text-sc-md text-(--sc-danger)">
								{error.message}
								<ErrorDetail className="mt-1" error={error.cause} />
							</span>
							<span className="text-sc-sm text-(--sc-text-muted)">{t("modelPicker.notRespondingHint")}</span>
							<Button
								disabled={!sidecarReady}
								onClick={() => void load(true, t("modelPicker.stillNotResponding"))}
								size="sm"
								title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
							>
								{t("modelPicker.retry")}
							</Button>
						</div>
					) : loading ? (
						<div className="flex justify-center py-10">
							<Spinner label={t("modelPicker.loading")} size="sm" />
						</div>
					) : availableModels.length === 0 ? (
						<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
							<span className="text-sc-md text-(--sc-text-secondary)">{t("modelPicker.empty")}</span>
							<Button onClick={manageProviders} size="sm" variant="primary">
								{t("modelPicker.connectProvider")}
							</Button>
						</div>
					) : groups.length === 0 ? (
						<div className="py-10 text-center text-sc-md text-(--sc-text-muted)">
							{t("modelPicker.noMatch", { query })}
						</div>
					) : (
						groups.map(([provider, models]) => {
							const auth = authByProvider.get(provider);
							const providerName = nameByProvider.get(provider) ?? provider;
							return (
								<section aria-label={providerName} className="mb-1" key={provider} role="group">
									<div className="flex min-h-8 items-center gap-2 px-2.5 pt-2 pb-1">
										<span className="truncate text-sc-xs font-medium text-(--sc-text-muted)">
											{providerName}
										</span>
										{auth && !auth.authenticated && (
											<Badge variant={auth.available ? "warning" : "muted"}>
												{auth.available
													? t("modelPicker.auth.notSignedIn")
													: t("modelPicker.auth.unavailable")}
											</Badge>
										)}
										{auth?.available && !auth.authenticated && (
											<Button className="ml-auto" onClick={manageProviders} size="sm" variant="ghost">
												{t("providerList.connect")}
											</Button>
										)}
									</div>
									{models.map(model => {
										const key = `${provider}/${model.id}`;
										const isCurrent = forPool
											? (pool?.members.some(member => member.selector === key) ?? false)
											: current?.provider === provider && current.id === model.id;
										const optionIndex = indexByKey.get(key) ?? 0;
										const isActive = optionIndex === activeIndex;
										const over = !isCurrent && isOverContext(model);
										const small = model.contextWindow != null && model.contextWindow < MIN_SERVING_CONTEXT;
										const subtitle = [
											model.name && model.name !== model.id ? model.id : null,
											model.description,
										]
											.filter(Boolean)
											.join(" · ");
										const compaction = compactionPoints?.bySelector.get(key);
										return (
											<button
												aria-selected={isCurrent}
												className={cx(
													"flex min-h-10 w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 py-1.5 text-left disabled:cursor-not-allowed",
													isActive ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
												)}
												data-option-index={optionIndex}
												disabled={switching !== null || !sidecarReady}
												id={`${listboxId}-option-${optionIndex}`}
												key={key}
												onClick={() => void select(provider, model.id)}
												onMouseEnter={() => setActiveIndex(optionIndex)}
												role="option"
												title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
												type="button"
											>
												<span className="flex min-w-0 flex-1 flex-col">
													<span className="flex min-w-0 items-center gap-1.5">
														<span
															className={cx(
																"truncate text-sc-md",
																isCurrent ? "font-medium text-(--sc-text)" : "text-(--sc-text)",
																over && "text-(--sc-text-muted)",
															)}
														>
															{modelDisplayName(model)}
														</span>
														{model.isRecommended && (
															<Badge variant="accent">{t("modelPicker.badge.recommended")}</Badge>
														)}
														{model.isNew && <Badge variant="info">{t("modelPicker.badge.new")}</Badge>}
														{model.isBeta && (
															<Badge variant="warning">{t("modelPicker.badge.beta")}</Badge>
														)}
													</span>
													{(subtitle || compaction) && (
														<span className="flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
															{subtitle && (
																<span className="truncate" title={model.description}>
																	{subtitle}
																</span>
															)}
															{subtitle && compaction && <span aria-hidden>·</span>}
															{compaction && <CompactsAt className="shrink-0" point={compaction} />}
														</span>
													)}
												</span>
												{model.contextWindow != null && (
													<span
														className={cx(
															"shrink-0 text-sc-xs tabular-nums",
															small ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
														)}
														title={small ? t("modelPicker.smallContextHint") : undefined}
													>
														{t("modelPicker.context", { tokens: formatTokens(model.contextWindow) })}
													</span>
												)}
												{model.int != null && Number.isFinite(model.int) && (
													<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
														{t("modelPicker.intelligence", { value: Math.round(model.int) })}
													</span>
												)}
												{model.tps != null && Number.isFinite(model.tps) && model.tps > 0 && (
													<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
														{t("modelPicker.speed", {
															value: model.tps >= 10 ? Math.round(model.tps) : model.tps.toFixed(1),
														})}
													</span>
												)}
												{over && (
													<span
														className="flex shrink-0 items-center gap-1 text-sc-xs font-medium text-(--sc-warning)"
														title={t("modelPicker.overContextHint", {
															current: formatTokens(contextUsage?.tokens),
															limit: formatTokens(model.contextWindow),
														})}
													>
														<TriangleAlert aria-hidden className="size-(--sc-icon-sm)" />
														{t("modelPicker.overContext")}
													</span>
												)}
												{switching === key && <Spinner size="sm" />}
												{isCurrent && (
													<Check
														aria-label={forPool ? t("modelPool.inPool") : t("modelPicker.current")}
														className="size-(--sc-icon-sm) shrink-0 text-(--sc-accent)"
													/>
												)}
											</button>
										);
									})}
								</section>
							);
						})
					)}
				</div>
				<div className="flex items-center gap-4 border-t border-(--sc-divider) py-2 pr-2 pl-3.5 text-sc-xs text-(--sc-text-muted)">
					<span className="min-w-0 flex-1 truncate">
						{forPool ? t("modelPool.pickerHint") : t("modelPicker.defaultHint")}
					</span>
					<span className="flex shrink-0 items-center gap-1.5 max-sm:hidden">
						<Kbd shortcut="↑" />
						<Kbd shortcut="↓" />
						{t("modelPicker.keys.move")}
					</span>
					<span className="flex shrink-0 items-center gap-1.5 max-sm:hidden">
						<Kbd shortcut="↵" />
						{t("modelPicker.keys.pick")}
					</span>
					<Button icon={<Settings2 />} onClick={manageProviders} size="sm" variant="ghost">
						{t("modelPicker.manageProviders")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
