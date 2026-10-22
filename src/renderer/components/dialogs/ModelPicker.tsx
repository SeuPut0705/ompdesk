/**
 * Model picker (Picker container): search, models grouped by provider with
 * connected providers first, current model checked. Picking switches the
 * session (`set_model`) and saves the pick as the default for new sessions
 * (`modelRoles.default`), the way omp's own `/model` picker does — without it
 * every new session falls back to omp's catalog choice, which can be a keyless
 * on-device model that cannot hold a coding session.
 *
 */

import { Check, Settings2, TriangleAlert } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { LoginProvider, ModelInfo } from "../../../shared/rpc-types";
import { applyModelInfo, hydrateSession } from "../../hooks/use-rpc-events";
import { compactionPointValue, useCompactionPoints } from "../../lib/compaction-limits";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import { runManualMaintenance } from "../../lib/messages";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Button,
	ErrorDetail,
	Kbd,
	Modal,
	type ModalAnchor,
	SearchField,
	SkeletonRows,
	Spinner,
} from "../common";
import { ThinkingLevelField } from "../layout/composer/ThinkingControl";
import { persistDefaultModel } from "../onboarding/default-model";
import { ProviderMark } from "../settings/providers/ProviderMark";
import { MIN_SERVING_CONTEXT, modelDisplayName } from "../settings/providers/provider-catalog";

/** Rows in the Recent group (stock's `/models` hub keeps 15; a dialog wants a glance). */
const RECENT_LIMIT = 5;
const RECENT_GROUP = "recent";

interface PickerGroup {
	id: string;
	/** The provider every row belongs to; null for the Recent group. */
	provider: string | null;
	models: ModelInfo[];
}

export function ModelPicker() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen);
	const close = useUiStore(state => state.closeModelPicker);
	const openProviders = useUiStore(state => state.openProviders);
	const availableModels = useModelStore(state => state.availableModels);
	const catalogProviders = useModelStore(state => state.providers);
	const current = useModelStore(state => state.model);
	const supportsThinking = useModelStore(state => state.availableThinkingLevels.length > 0);
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
	const [recentSelectors, setRecentSelectors] = useState<readonly string[]>([]);

	/** Login flows are the picker's own concern, but the model list is shared
	 * catalog state: it commits through the store's generation guard, so a
	 * `model_catalog_update` that lands mid-read can never be reverted by this
	 * response. `forceRefresh` belongs to the retry path, where the user is
	 * disputing what the list shows. */
	const load = useCallback(
		async (forceRefresh: boolean, failedCopy?: string): Promise<void> => {
			const version = ++requestVersion.current;
			// The list the store already holds (this session's, or the last run's snapshot) stays on screen and the
			// read replaces it in place: the wait only shows when nothing is known yet.
			const known = useModelStore.getState().availableModels.length > 0;
			setLoading(!known);
			setError(null);
			if (!sidecarReady) {
				if (!known) setError({ message: t("modelPicker.notConnected") });
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

	// The picker opens over the focused session's composer, its right edge on the composer's (the model chip's
	// side), and leaves the window as it is behind it. Without a composer on screen (a page open) it opens at the top.
	const [anchor, setAnchor] = useState<ModalAnchor | null>(null);
	useLayoutEffect(() => {
		if (!open) return undefined;
		const measure = () => {
			const box = document
				.querySelector('.omp-session-pane[data-active="true"] .omp-composer-box')
				?.getBoundingClientRect();
			setAnchor(box && box.width > 0 && box.height > 0 ? { top: box.top, right: box.right } : null);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open]);

	// Stock's MRU order; an omp without it (or a failed read) just shows no Recent group.
	useEffect(() => {
		if (!open || !sidecarReady) return undefined;
		let cancelled = false;
		void tabRpc
			.getRecentModels()
			.then(response => {
				const data = response.success ? response.data : undefined;
				const selectors =
					data && typeof data === "object" && "selectors" in data && Array.isArray(data.selectors)
						? data.selectors.filter((selector): selector is string => typeof selector === "string")
						: [];
				if (!cancelled) setRecentSelectors(selectors);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open, sidecarReady, tabRpc]);

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

	const groups = useMemo((): PickerGroup[] => {
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
		const byProvider = [...map.entries()]
			.sort(
				([a], [b]) =>
					Number(connected(b)) - Number(connected(a)) ||
					(nameByProvider.get(a) ?? a).localeCompare(nameByProvider.get(b) ?? b),
			)
			.map(([provider, models]): PickerGroup => ({ id: provider, provider, models }));
		// Stock's most-recently-used models on top while nothing is typed (the
		// `/models` hub's Recent block); a pool pick has no "recent" meaning.
		if (q.length > 0) return byProvider;
		const bySelector = new Map(filtered.map(model => [`${model.provider}/${model.id}`, model]));
		const recent = recentSelectors.flatMap(selector => bySelector.get(selector) ?? []).slice(0, RECENT_LIMIT);
		return recent.length > 0 ? [{ id: RECENT_GROUP, provider: null, models: recent }, ...byProvider] : byProvider;
	}, [availableModels, connected, nameByProvider, query, recentSelectors]);

	// Flat row order (group order → in-group order) for keyboard navigation; a
	// recent model also listed under its provider is a separate row.
	const flatOptions = useMemo(
		() =>
			groups.flatMap(group =>
				group.models.map(model => ({
					provider: model.provider,
					modelId: model.id,
					key: `${group.id}:${model.provider}/${model.id}`,
				})),
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
		const tokens = contextUsage?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		return tokens > 0 && contextWindow > 0 && tokens > contextWindow;
	};

	const select = async (provider: string, modelId: string) => {
		if (!sidecarReady) return;
		const key = `${provider}/${modelId}`;
		setSwitching(key);
		try {
			const target = availableModels.find(m => m.provider === provider && m.id === modelId);
			// TUI parity: picking a model whose context window is smaller than the
			// live session usage compacts with the CURRENT model first, then
			// switches. The row carries the over-context warning before the pick.
			const overContext = target !== undefined && isOverContext(target);
			if (overContext) {
				const { response: compactRes, cancelled } = await runManualMaintenance(
					"compact",
					() => tabRpc.compact(),
					tabId,
				);
				if (cancelled) {
					toast({ variant: "info", message: t("command.compactCancelled") });
					return;
				}
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
		const target = listboxTarget(event.key, activeIndex, flatOptions.length, { wrap: false });
		if (target !== null) {
			event.preventDefault();
			setActiveIndex(target);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const option = flatOptions[activeIndex];
			if (option) void select(option.provider, option.modelId);
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
			anchor={anchor}
			ariaLabel={t("modelPicker.searchLabel")}
			backdrop={false}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement={anchor ? "above" : "top"}
			size="picker-compact"
		>
			<div className="flex h-full min-h-0 flex-col">
				<div className="border-b border-(--sc-divider) p-1.5">
					<SearchField
						listbox={{ id: listboxId, activeId: flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined }}
						controlSize="sm"
						label={t("modelPicker.searchLabel")}
						onKeyDown={onKeyDown}
						onValueChange={setQuery}
						placeholder={t("modelPicker.placeholder")}
						ref={inputRef}
						value={query}
					/>
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
							<span className="text-sc-sm text-(--sc-danger)">
								{error.message}
								<ErrorDetail className="mt-1" error={error.cause} />
							</span>
							<span className="text-sc-xs text-(--sc-text-muted)">{t("modelPicker.notRespondingHint")}</span>
							<Button
								disabled={!sidecarReady}
								onClick={() => void load(true, t("modelPicker.stillNotResponding"))}
								size="sm"
								title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
							>
								{t("common.retry")}
							</Button>
						</div>
					) : loading ? (
						<SkeletonRows className="py-2" label={t("modelPicker.loading")} widths={[60, 44, 70, 52]} />
					) : availableModels.length === 0 ? (
						<div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
							<span className="text-sc-sm text-(--sc-text-secondary)">{t("modelPicker.empty")}</span>
							<Button onClick={manageProviders} size="sm" variant="primary">
								{t("modelPicker.connectProvider")}
							</Button>
						</div>
					) : groups.length === 0 ? (
						<div className="px-2 py-6 text-center text-sc-sm text-(--sc-text-muted)">
							{t("modelPicker.noMatch", { query })}
						</div>
					) : (
						groups.map(({ id: groupId, provider, models }) => {
							const auth = provider === null ? undefined : authByProvider.get(provider);
							const groupName =
								provider === null ? t("modelPicker.recent") : (nameByProvider.get(provider) ?? provider);
							return (
								<section aria-label={groupName} data-model-group={groupId} key={groupId} role="group">
									<div
										className={cx(
											"flex items-center gap-1.5 px-2 pt-1.5 pb-0.5",
											auth?.available && !auth.authenticated ? "min-h-(--sc-control-sm)" : "min-h-6",
										)}
									>
										<span className="truncate text-sc-2xs font-medium tracking-wider text-(--sc-text-muted) uppercase">
											{groupName}
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
										const key = `${model.provider}/${model.id}`;
										const isCurrent = current?.provider === model.provider && current.id === model.id;
										const optionIndex = indexByKey.get(`${groupId}:${key}`) ?? 0;
										const isActive = optionIndex === activeIndex;
										const over = !isCurrent && isOverContext(model);
										const small = model.contextWindow != null && model.contextWindow < MIN_SERVING_CONTEXT;
										const compaction = compactionPoints?.bySelector.get(key);
										const compactionValue = compaction ? compactionPointValue(compaction) : null;
										// Secondary facts live in the row's tooltip, not on extra lines.
										const details = [
											model.name && model.name !== model.id ? model.id : null,
											model.description,
											model.int != null && Number.isFinite(model.int)
												? t("modelPicker.intelligence", { value: Math.round(model.int) })
												: null,
											model.tps != null && Number.isFinite(model.tps) && model.tps > 0
												? t("modelPicker.speed", {
														value: model.tps >= 10 ? Math.round(model.tps) : model.tps.toFixed(1),
													})
												: null,
											compaction
												? compactionValue === null
													? t("compactionLimits.compactsOff")
													: t("compactionLimits.compactsAt", { value: compactionValue })
												: null,
											small ? t("modelPicker.smallContextHint") : null,
										]
											.filter(Boolean)
											.join(" · ");
										return (
											<button
												aria-selected={isCurrent}
												className={cx(
													"flex min-h-(--sc-control-sm) w-full items-center gap-2 rounded-(--sc-radius-md) px-2 py-0.5 text-left disabled:cursor-not-allowed disabled:opacity-50",
													isActive ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
												)}
												data-model-option
												data-option-index={optionIndex}
												disabled={switching !== null || !sidecarReady}
												id={`${listboxId}-option-${optionIndex}`}
												key={key}
												onClick={() => void select(model.provider, model.id)}
												onMouseEnter={() => setActiveIndex(optionIndex)}
												role="option"
												tabIndex={-1}
												title={!sidecarReady ? t("modelPicker.notConnected") : details || undefined}
												type="button"
											>
												<ProviderMark
													className="size-4"
													provider={{
														id: model.provider,
														name: nameByProvider.get(model.provider) ?? model.provider,
													}}
												/>
												<span
													className={cx(
														"min-w-0 flex-1 truncate text-sc-sm",
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
												{model.isBeta && <Badge variant="warning">{t("modelPicker.badge.beta")}</Badge>}
												{model.contextWindow != null && (
													<span
														className={cx(
															"shrink-0 text-sc-2xs tabular-nums",
															small ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
														)}
													>
														{formatTokens(model.contextWindow, { trimZero: true })}
													</span>
												)}
												{over && (
													<span
														aria-label={t("modelPicker.overContext")}
														className="flex shrink-0 text-(--sc-warning)"
														role="img"
														title={t("modelPicker.overContextHint", {
															current: formatTokens(contextUsage?.tokens),
															limit: formatTokens(model.contextWindow),
														})}
													>
														<TriangleAlert aria-hidden className="size-(--sc-icon-sm)" />
													</span>
												)}
												{switching === key && <Spinner size="sm" spin />}
												{isCurrent && (
													<Check
														aria-label={t("modelPicker.current")}
														className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)"
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
				{/* Model and effort in one place: the segmented thinking row for the model in use (two taps from the
				    model chip). Picking a model closes the dialog, so the row is for the current one. */}
				{supportsThinking && (
					<div className="border-t border-(--sc-divider) px-3 py-2" data-model-picker-thinking>
						<ThinkingLevelField variant="segmented" />
					</div>
				)}
				<div
					className="flex items-center gap-3 border-t border-(--sc-divider) px-2 py-1 text-sc-2xs text-(--sc-text-muted)"
					title={t("modelPicker.defaultHint")}
				>
					<span className="flex shrink-0 items-center gap-1 max-sm:hidden">
						<Kbd shortcut="↑" />
						<Kbd shortcut="↓" />
						{t("modelPicker.keys.move")}
					</span>
					<span className="flex shrink-0 items-center gap-1 max-sm:hidden">
						<Kbd shortcut="↵" />
						{t("modelPicker.keys.pick")}
					</span>
					<Button className="ml-auto" icon={<Settings2 />} onClick={manageProviders} size="sm" variant="ghost">
						{t("modelPicker.manageProviders")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
