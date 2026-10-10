/**
 * Searchable dropdown for values that reference a model or a provider.
 *
 * Two sources of options:
 * - Fetched (default): string-typed settings such as
 *   providers.webSearchGeminiModel or mnemopi.llmModel. Options are fetched
 *   (forced) on every open through the model store, so credential and
 *   models.yml changes never leave a process-lifetime cache. Custom values
 *   stay allowed: the current value is pinned when it is not in the fetched
 *   list, and the search text can be committed verbatim.
 * - Static `groups`: a caller-owned candidate pool (model roles), grouped
 *   under headings. No fetch, no free-text entry; a saved value outside the
 *   pool is still pinned so it stays visible and clearable.
 *
 * Models show their display name with the `provider/id` selector beside it.
 * Commits go through the caller (`""` clears).
 */

import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableModelsResult, ProvidersResult } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useModelStore } from "../../stores/model";
import { Button, Spinner } from "../common";

export type SettingRefKind = "model" | "provider";

/**
 * Classify a setting path as a model/provider reference. Conservative by
 * design: only the last path segment is inspected, so `model.loopGuard.*`
 * (a namespace, and boolean/number-typed anyway) or `stt.language` never
 * match. Callers apply this to string-typed, non-secret entries only.
 */
export function settingRefKind(path: string): SettingRefKind | null {
	const segment = path.slice(path.lastIndexOf(".") + 1);
	if (/model$/i.test(segment)) return "model";
	if (/provider$/i.test(segment)) return "provider";
	return null;
}

export interface ModelValueOption {
	/** Committed value (`provider/id` for models, provider id for providers). */
	value: string;
	/** Display name; the value itself is shown when absent. */
	label?: string;
	/** Secondary text (the selector under a display name, a provider's name). */
	detail?: string;
	disabled?: boolean;
}

export interface ModelValueGroup {
	label: string;
	options: readonly ModelValueOption[];
}

type FetchState = "idle" | "loading" | "error" | "ready";

/** Both readers force a catalog refresh: a non-forced read is answered by a
 * still-fresh cache row, which is exactly the stale provider/model list this
 * dropdown exists to avoid. They read through the model store so the committed
 * catalog and these options can never disagree. */
async function modelOptions(read: () => Promise<AvailableModelsResult>): Promise<ModelValueOption[]> {
	const { models } = await read();
	const seen = new Set<string>();
	const options: ModelValueOption[] = [];
	for (const model of models) {
		const value = `${model.provider}/${model.id}`;
		if (seen.has(value)) continue;
		seen.add(value);
		const named = typeof model.name === "string" && model.name.length > 0 && model.name !== model.id;
		options.push(named ? { value, label: model.name, detail: value } : { value });
	}
	return options;
}

async function providerOptions(read: () => Promise<ProvidersResult>): Promise<ModelValueOption[]> {
	const { providers } = await read();
	return providers.map(provider => ({
		value: provider.id,
		detail: provider.name,
		disabled: provider.disabled,
	}));
}

function matches(option: ModelValueOption, needle: string): boolean {
	return (
		option.value.toLowerCase().includes(needle) ||
		(option.label ?? "").toLowerCase().includes(needle) ||
		(option.detail ?? "").toLowerCase().includes(needle)
	);
}

const PANEL_WIDTH = 320;
const PANEL_MAX_HEIGHT = 288;

/** Panel position for a trigger rect: right-aligned to it, below unless only above has room. */
function panelPlacement(rect: DOMRect): { top: number; left: number } {
	const openUp = window.innerHeight - rect.bottom < PANEL_MAX_HEIGHT + 16 && rect.top > PANEL_MAX_HEIGHT + 16;
	return {
		left: Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
		top: openUp ? Math.max(8, rect.top - PANEL_MAX_HEIGHT - 4) : rect.bottom + 4,
	};
}

const ROW_CLASS =
	"flex w-full items-center gap-2 rounded-(--sc-radius-sm) px-2 py-1.5 text-left text-sc-md text-(--sc-text) transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) focus-visible:bg-(--sc-hover) disabled:cursor-not-allowed disabled:opacity-50";

const GROUP_LABEL_CLASS =
	"px-2 pt-2 pb-0.5 text-sc-2xs font-semibold tracking-wide text-(--sc-text-muted) uppercase first:pt-1";

export interface ModelValueSelectProps {
	kind: SettingRefKind;
	/** Current committed value; "" means unset. */
	value: string;
	disabled?: boolean;
	/** Commit a new value via the caller's flow ("" clears). */
	onCommit: (value: string) => void;
	/** Trigger text shown while value is "" (defaults to the unset label). */
	placeholder?: string;
	/** Caller-owned grouped options; replaces the catalog fetch and free-text entry. */
	groups?: readonly ModelValueGroup[];
	/** Accessible name of the trigger when no visible label names it. */
	ariaLabel?: string;
	/** Trigger tooltip (e.g. why it is disabled). */
	title?: string;
	/** Label of the row that commits "" (defaults to "Clear (use default)"). */
	clearLabel?: string;
}

export function ModelValueSelect({
	kind,
	value,
	disabled,
	onCommit,
	placeholder,
	groups,
	ariaLabel,
	title,
	clearLabel,
}: ModelValueSelectProps) {
	const t = useT();
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [fetched, setFetched] = useState<ModelValueOption[]>([]);
	const [fetchState, setFetchState] = useState<FetchState>("idle");
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const requestIdRef = useRef(0);
	const isStatic = groups !== undefined;

	const fetchOptions = useCallback(() => {
		const requestId = ++requestIdRef.current;
		setFetchState("loading");
		setFetchError(null);
		const load = kind === "model" ? modelOptions(refreshAvailableModels) : providerOptions(refreshProviders);
		return load
			.then(result => {
				if (requestIdRef.current !== requestId) return;
				setFetched(result);
				setFetchState("ready");
			})
			.catch((cause: unknown) => {
				if (requestIdRef.current !== requestId) return;
				setFetchError(cause instanceof Error ? cause.message : String(cause));
				setFetchState("error");
			});
	}, [kind, refreshAvailableModels, refreshProviders]);

	// Fetch on every open. A provider/model edit can happen while this settings
	// row remains mounted, so retaining a previous "ready" result is stale.
	useEffect(() => {
		if (!open || isStatic) return;
		void fetchOptions();
		return () => {
			requestIdRef.current++;
		};
	}, [fetchOptions, isStatic, open]);

	// Focus the filter input once the panel is up.
	useEffect(() => {
		if (!open) return;
		requestAnimationFrame(() => searchRef.current?.focus());
	}, [open]);

	// A control that becomes unusable (sidecar dropped) must not keep offering
	// commits from an already-open panel.
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	// Close on outside click. A scroll re-places the viewport-fixed panel under
	// its trigger instead of closing it: opening the panel refreshes the
	// catalog, the provider list above a settings row grows, and the column's
	// scroll anchoring then scrolls and shifts the row by a few pixels, all
	// while the user is typing into the panel. Only a trigger scrolled out of
	// its scroller (or the viewport) closes the panel.
	useEffect(() => {
		if (!open) return;
		const onMouseDown = (event: MouseEvent) => {
			if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
				setOpen(false);
			}
		};
		const onScroll = (event: Event) => {
			if (listRef.current && event.target instanceof Node && listRef.current.contains(event.target)) return;
			const rect = triggerRef.current?.getBoundingClientRect();
			const bounds =
				event.target instanceof Element
					? event.target.getBoundingClientRect()
					: { top: 0, bottom: window.innerHeight };
			if (!rect || rect.bottom <= bounds.top || rect.top >= bounds.bottom) {
				setOpen(false);
				return;
			}
			setPlacement(panelPlacement(rect));
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("scroll", onScroll, true);
		};
	}, [open]);

	const openPanel = () => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) setPlacement(panelPlacement(rect));
		setQuery("");
		setOpen(true);
	};

	const closePanel = () => {
		setOpen(false);
		triggerRef.current?.focus();
	};

	const choose = (next: string) => {
		setOpen(false);
		setQuery("");
		triggerRef.current?.focus();
		if (next !== value) onCommit(next);
	};

	const allOptions = useMemo(() => (groups ? groups.flatMap(group => group.options) : fetched), [groups, fetched]);
	const ready = isStatic || fetchState === "ready";

	const trimmedQuery = query.trim();
	const loweredQuery = trimmedQuery.toLowerCase();
	const filteredGroups = useMemo(() => {
		const source: readonly ModelValueGroup[] = groups ?? [{ label: "", options: fetched }];
		return source
			.map(group => ({
				label: group.label,
				options: loweredQuery ? group.options.filter(option => matches(option, loweredQuery)) : group.options,
			}))
			.filter(group => group.options.length > 0);
	}, [groups, fetched, loweredQuery]);
	const filteredCount = filteredGroups.reduce((sum, group) => sum + group.options.length, 0);

	// The current value is pinned as a custom row when the options do not
	// contain it (hand-written overrides stay selectable/clearable).
	const currentOption = allOptions.find(option => option.value === value);
	const currentIsCustom = value !== "" && ready && currentOption === undefined;
	// In fetched mode the search text doubles as a custom-value entry when it is
	// not an exact known option.
	const queryIsCustom =
		!isStatic && trimmedQuery !== "" && !allOptions.some(option => option.value.toLowerCase() === loweredQuery);

	const noun = kind === "model" ? t("modelValue.noun.models") : t("modelValue.noun.providers");
	const triggerText = value === "" ? (placeholder ?? t("modelValue.unset")) : (currentOption?.label ?? value);
	const triggerMono = value !== "" && currentOption?.label === undefined;

	const moveFocus = (direction: 1 | -1, edge?: "first" | "last") => {
		const options = listRef.current
			? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'))
			: [];
		if (options.length === 0) return;
		const index = options.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			edge === "first"
				? 0
				: edge === "last"
					? options.length - 1
					: index < 0
						? direction > 0
							? 0
							: options.length - 1
						: (index + direction + options.length) % options.length;
		options[next]?.focus();
	};

	const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveFocus(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveFocus(-1);
		} else if (event.key === "Home" && event.target !== searchRef.current) {
			event.preventDefault();
			moveFocus(1, "first");
		} else if (event.key === "End" && event.target !== searchRef.current) {
			event.preventDefault();
			moveFocus(-1, "last");
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closePanel();
		}
	};

	const renderOption = (option: ModelValueOption) => {
		const selected = option.value === value;
		// `disabled` is a recognition label, not a lock: choosing a disabled
		// provider for a `*Provider` setting only fails when something later
		// tries to call it.
		return (
			<button
				aria-selected={selected}
				className={cx(ROW_CLASS, selected && "bg-(--sc-selected)")}
				disabled={option.disabled === true}
				key={option.value}
				onClick={() => choose(option.value)}
				role="option"
				tabIndex={-1}
				type="button"
			>
				<span className={cx("min-w-0 flex-1 truncate", option.label === undefined && "font-mono text-sc-sm")}>
					{option.label ?? option.value}
				</span>
				{option.detail !== undefined && (
					<span
						className={cx(
							"min-w-0 shrink truncate text-sc-xs text-(--sc-text-muted)",
							option.label !== undefined && "font-mono",
						)}
					>
						{option.disabled ? t("modelValue.providerDisabled", { name: option.detail }) : option.detail}
					</span>
				)}
				{selected && <Check aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-accent)" />}
			</button>
		);
	};

	return (
		<div className="relative" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				className="flex h-(--sc-control-md) w-full items-center gap-1.5 rounded-(--sc-radius-md) border border-(--sc-border) bg-(--sc-field) px-2.5 text-left text-sc-md transition-colors duration-(--sc-duration-instant) hover:border-(--sc-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
				disabled={disabled}
				onClick={() => (open ? setOpen(false) : openPanel())}
				ref={triggerRef}
				title={title}
				type="button"
			>
				<span
					className={cx(
						"min-w-0 flex-1 truncate",
						triggerMono && "font-mono text-sc-sm",
						value === "" ? "text-(--sc-text-subtle)" : "text-(--sc-text)",
					)}
				>
					{triggerText}
				</span>
				<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			</button>
			{open && placement !== null && (
				<div
					className="fixed z-(--sc-z-popover) flex flex-col overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) shadow-(--sc-shadow-md)"
					onKeyDown={onListKeyDown}
					style={{ top: placement.top, left: placement.left, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
				>
					<div className="flex items-center gap-2 border-b border-(--sc-divider) px-2.5 py-2">
						<Search aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
						<input
							aria-label={t("modelValue.searchAria", { noun })}
							className="min-w-0 flex-1 bg-transparent text-sc-md text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle)"
							onChange={event => setQuery(event.target.value)}
							placeholder={t("modelValue.searchPlaceholder", { noun })}
							ref={searchRef}
							value={query}
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-1" ref={listRef} role="listbox">
						{!ready && fetchState === "error" ? (
							<div className="flex flex-col items-center gap-2 py-6">
								<span className="px-3 text-center text-sc-sm text-(--sc-danger)">
									{fetchError ?? t("modelValue.loadFailed", { noun })}
								</span>
								<Button icon={<RefreshCw />} onClick={() => void fetchOptions()} size="sm" variant="secondary">
									{t("modelValue.retry")}
								</Button>
							</div>
						) : !ready ? (
							<div className="flex items-center justify-center py-6">
								<Spinner label={t("modelValue.loading", { noun })} size="sm" />
							</div>
						) : (
							<>
								{currentIsCustom && (
									<>
										<div className={GROUP_LABEL_CLASS}>{t("modelValue.currentCustom")}</div>
										{renderOption({ value })}
									</>
								)}
								{filteredGroups.map(group => (
									<div key={group.label || "options"} role="group" aria-label={group.label || undefined}>
										{group.label && <div className={GROUP_LABEL_CLASS}>{group.label}</div>}
										{group.options.map(renderOption)}
									</div>
								))}
								{filteredCount === 0 && !queryIsCustom && (
									<div className="px-2 py-6 text-center text-sc-sm text-(--sc-text-muted)">
										{allOptions.length === 0
											? t("modelValue.noneAvailable", { noun })
											: t("modelValue.noMatch", { noun, query: trimmedQuery })}
									</div>
								)}
								{queryIsCustom && (
									<button className={ROW_CLASS} onClick={() => choose(trimmedQuery)} type="button">
										<span className="min-w-0 flex-1 truncate">
											{t("modelValue.useCustom", { query: trimmedQuery })}
										</span>
									</button>
								)}
								{value !== "" && (
									<button
										className={cx(ROW_CLASS, "mt-0.5 rounded-t-none border-t border-(--sc-divider)")}
										onClick={() => choose("")}
										type="button"
									>
										<span className="min-w-0 flex-1 text-(--sc-text-muted)">
											{clearLabel ?? t("modelValue.clear")}
										</span>
									</button>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
