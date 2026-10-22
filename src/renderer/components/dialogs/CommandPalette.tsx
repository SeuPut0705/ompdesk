import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
/**
 * Cmd+K command palette: ranks the declarative command registry (exact >
 * prefix > word-prefix > substring > fuzzy, Hangul-aware, recents boosted)
 * and executes typed UI affordances (RPC actions, toggles, pickers, windows,
 * submenus, prompts) instead of injecting "/command" text into the composer.
 * Turn-starting and destructive commands never run from Enter on a partial
 * match: they need an exact query, an arrow-key selection, or a second Enter.
 */

import {
	Bot,
	ChartColumn,
	ChevronRight,
	CircleHelp,
	Cpu,
	Folder,
	Layers,
	type LucideIcon,
	MessageSquare,
	PanelRight,
	Plug,
	Puzzle,
	Route,
	Search,
	Settings,
	Terminal,
	TriangleAlert,
	Wrench,
	X,
} from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import {
	buildCommandMenu,
	type CommandAffordance,
	type CommandCategory,
	type CommandMenuItem,
	commandArgPrefill,
	commandGuard,
	createCommandContext,
	groupByCategory,
	prefillComposer,
} from "../../lib/command-registry";
import { enterNeedsConfirm, matchCommand, normalizeQuery, rankCommands } from "../../lib/command-search";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, InlineNotice, Kbd, Modal, OptionRow, SearchField, Spinner } from "../common";

const RECENT_KEY = "omp.palette.recent";
const RECENT_LIMIT = 5;

function sidecarBlocked(item: CommandMenuItem, ready: boolean): boolean {
	if (ready) return false;
	if (item.name === "new-tab" || item.name === "new-chat-tab" || item.name === "close" || item.name === "quit") {
		return false;
	}
	return item.affordance.kind === "action" || item.affordance.kind === "toggle" || item.affordance.kind === "prompt";
}

function loadRecent(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

function saveRecent(names: string[]) {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(names.slice(0, RECENT_LIMIT)));
	} catch {
		// Storage unavailable — recents are best-effort.
	}
}

/** One icon per palette section, so a row's kind reads before its label. */
const CATEGORY_ICON: Record<CommandCategory, LucideIcon> = {
	session: MessageSquare,
	agents: Bot,
	insights: ChartColumn,
	model: Cpu,
	providers: Plug,
	context: Layers,
	modes: Route,
	tools: Wrench,
	panel: PanelRight,
	workspace: Folder,
	extensions: Puzzle,
	settings: Settings,
	help: CircleHelp,
	other: Terminal,
};

/** The label with the typed query's first literal occurrence in the accent tone (fuzzy/초성 hits stay plain). */
function HighlightedLabel({ label, query }: { label: string; query: string }) {
	const needle = normalizeQuery(query).toLowerCase();
	const start = needle ? label.toLowerCase().indexOf(needle) : -1;
	if (start < 0) return label;
	const end = start + needle.length;
	return (
		<>
			{label.slice(0, start)}
			<mark className="bg-transparent text-(--sc-accent)">{label.slice(start, end)}</mark>
			{label.slice(end)}
		</>
	);
}

/** Execute an affordance, closing the palette and surfacing errors. */
async function runAffordance(
	affordance: CommandAffordance,
	close: () => void,
	t: (key: string) => string,
	rpc: TabRpc,
): Promise<void> {
	switch (affordance.kind) {
		case "action":
			close();
			try {
				await affordance.run();
			} catch (error) {
				toastError({ title: t("palette.failed"), error });
			}
			return;
		case "toggle":
			close();
			try {
				await affordance.set(!affordance.get());
			} catch (error) {
				toastError({ title: t("palette.failed"), error });
			}
			return;
		case "picker":
			close();
			affordance.open();
			return;
		case "window":
			close();
			affordance.open();
			return;
		case "prompt":
			close();
			try {
				const response = await rpc.prompt(affordance.text.trim());
				if (!response.success) throw new Error(response.error);
			} catch (error) {
				toastError({ title: t("palette.failed"), error });
			}
			return;
		case "submenu":
		case "unavailable":
			// Handled by the caller (submenu expands; unavailable is disabled).
			return;
	}
}

export function CommandPalette() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.commandPaletteOpen);
	const close = useUiStore(state => state.closeCommandPalette);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const fastModeEnabled = useModelStore(s => s.fastModeEnabled);
	const autoCompaction = useSettingsStore(s => s.autoCompaction);
	const autoRetry = useSettingsStore(s => s.autoRetry);
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const prewalkArmed = useSessionStore(s => s.prewalkArmed);
	const sidecarReady = useSessionStore(s => s.status) === "ready";

	const [query, setQuery] = useState("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	/** Set when the sidecar command fetch failed; the list stays usable (native
	 *  rows only) but says so and offers a retry instead of going silent. */
	const [commandsError, setCommandsError] = useState<InlineFailure | null>(null);
	const [loading, setLoading] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	/** The user moved the selection with the arrow keys (vs. the auto-selected top hit). */
	const [explicitSelection, setExplicitSelection] = useState(false);
	/** Guarded command awaiting its confirming second Enter. */
	const [armed, setArmed] = useState<string | null>(null);
	const [recent, setRecent] = useState<string[]>(loadRecent);
	/** When set, the palette is drilled into a submenu's items. */
	const [submenu, setSubmenu] = useState<CommandMenuItem | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	const fetchSeq = useRef(0);

	const refreshCommands = useCallback(() => {
		const seq = ++fetchSeq.current;
		if (!sidecarReady) {
			setAvailableCommands([]);
			setCommandsError({ message: t("common.notConnected") });
			setLoading(false);
			return;
		}
		setLoading(true);
		setCommandsError(null);
		tabRpc
			.getAvailableCommands()
			.then(response => {
				if (seq !== fetchSeq.current) return;
				if (!response.success) {
					setCommandsError(inlineFailure(response, t("palette.commandsFailed")));
					return;
				}
				const data = response.data as { commands?: AvailableCommand[] } | undefined;
				setAvailableCommands(data?.commands ?? []);
			})
			.catch((error: unknown) => {
				if (seq !== fetchSeq.current) return;
				setCommandsError(inlineFailure(error, t("palette.commandsFailed")));
			})
			.finally(() => {
				if (seq === fetchSeq.current) setLoading(false);
			});
	}, [sidecarReady, t, tabRpc.getAvailableCommands]);

	// Each open starts clean. Only `open` drives this: `refreshCommands` changes when omp connects, and
	// re-running the reset then wiped what the user had typed, leaving Enter on the top row ("New session").
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActiveIndex(0);
		setExplicitSelection(false);
		setArmed(null);
		setSubmenu(null);
		// The modal layer focuses the first control, which on the opening render
		// may still be the previous session's submenu chip: the search owns focus.
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	// The command list follows the connection: fetched on open and again once omp is ready.
	useEffect(() => {
		if (open) refreshCommands();
	}, [open, refreshCommands]);

	// Rows backed by a shortcut show the user's remapped chord.
	const keymapOverrides = useUiStore(state => state.keymapOverrides);
	const menuItems = useMemo(
		() =>
			buildCommandMenu(
				createCommandContext(
					{
						isStreaming,
						fastModeEnabled,
						autoCompaction,
						autoRetry,
						planModeEnabled,
						prewalkArmed,
						availableCommands,
						keymapOverrides,
					},
					{
						t,
						rpc: tabRpc,
						hydrateSession: () => (tabId ? hydrateTabSession(tabId) : hydrateSession()),
					},
				),
			),
		[
			t,
			isStreaming,
			fastModeEnabled,
			autoCompaction,
			autoRetry,
			planModeEnabled,
			prewalkArmed,
			availableCommands,
			tabRpc,
			tabId,
			keymapOverrides,
		],
	);

	// The working set: submenu items when drilled in, else the full menu.
	const workingItems = useMemo(
		() => (submenu?.affordance.kind === "submenu" ? submenu.affordance.items : menuItems),
		[submenu, menuItems],
	);

	const results = useMemo(() => rankCommands(workingItems, query, recent), [workingItems, query, recent]);

	// When not searching the top level, group by category for readability.
	const grouped = useMemo(() => {
		if (submenu || query.trim().length > 0) return null;
		return groupByCategory(results.map(r => r.item));
	}, [results, submenu, query]);

	// Pinned recents: top level with an empty query only, resolved against the
	// live menu so stale names from a previous session are dropped.
	const recentItems = useMemo(() => {
		if (submenu || query.trim().length > 0) return [];
		const byName = new Map(menuItems.map(item => [item.name, item]));
		return recent.map(name => byName.get(name)).filter((item): item is CommandMenuItem => item != null);
	}, [menuItems, recent, submenu, query]);

	const flatList = useMemo(() => {
		if (grouped) {
			const flat: CommandMenuItem[] = [...recentItems];
			for (const items of grouped.values()) flat.push(...items);
			return flat;
		}
		return results.map(r => r.item);
	}, [grouped, recentItems, results]);

	const recordRecent = useCallback(
		(name: string) => {
			const next = [name, ...recent.filter(n => n !== name)].slice(0, RECENT_LIMIT);
			setRecent(next);
			saveRecent(next);
		},
		[recent],
	);

	/** Back to the top hit, auto-selected (not explicit), nothing armed. */
	const resetSelection = useCallback(() => {
		setActiveIndex(0);
		setExplicitSelection(false);
		setArmed(null);
	}, []);

	const execute = useCallback(
		(item: CommandMenuItem) => {
			if (item.affordance.kind === "unavailable") {
				toast({ variant: "warning", message: `${item.label}: ${item.affordance.reason}` });
				return;
			}
			if (sidecarBlocked(item, sidecarReady)) {
				toast({ variant: "warning", message: `${item.label}: ${t("common.notConnected")}` });
				return;
			}
			if (item.affordance.kind === "submenu") {
				setSubmenu(item);
				setQuery("");
				resetSelection();
				requestAnimationFrame(() => inputRef.current?.focus());
				return;
			}
			// Argument-taking commands never run blind: fill the composer with the
			// invocation prefix so the user supplies the argument.
			const prefill = commandArgPrefill(item);
			if (prefill !== null) {
				recordRecent(item.name);
				close();
				prefillComposer(prefill);
				return;
			}
			recordRecent(item.name);
			void runAffordance(item.affordance, close, t, tabRpc);
		},
		[recordRecent, close, sidecarReady, t, tabRpc, resetSelection],
	);

	/** Move the selection by `delta`, skipping disabled rows. An arrow-key pick is explicit. */
	const step = useCallback(
		(delta: number) => {
			setExplicitSelection(true);
			setArmed(null);
			setActiveIndex(current => {
				for (let i = current + delta; i >= 0 && i < flatList.length; i += delta) {
					if (!sidecarBlocked(flatList[i], sidecarReady)) return i;
				}
				return current;
			});
		},
		[flatList, sidecarReady],
	);

	const leaveSubmenu = () => {
		setSubmenu(null);
		setQuery("");
		resetSelection();
	};

	// Bound to the palette body, not the input: after clicking a row, focus sits
	// on that button, and arrow keys held only by the input stop working.
	// Escape belongs to the modal layer (`onClose` below).
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (isImeKeyEvent(event)) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				step(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				step(-1);
				break;
			case "ArrowLeft":
				if (submenu && query.length === 0) {
					event.preventDefault();
					leaveSubmenu();
				}
				break;
			case "Enter": {
				// The input owns Enter. A focused row button already activates itself
				// on Enter, so running the selection here too would execute twice.
				if (event.target !== inputRef.current) break;
				event.preventDefault();
				const item = flatList[activeIndex];
				if (!item) break;
				// A turn-starting/destructive command never runs off the auto-selected
				// top hit of a partial query: the first Enter arms it, the second runs.
				if (
					armed !== item.name &&
					enterNeedsConfirm(commandGuard(item), matchCommand(query, item), explicitSelection)
				) {
					setArmed(item.name);
					break;
				}
				execute(item);
				break;
			}
		}
	};

	// Clamp the selection whenever the result set changes (a stale index left
	// Enter reading flatList[undefined]) and whenever the palette re-opens, since
	// the open effect resets it to 0 — which may be a disabled row.
	const resultCount = flatList.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `open` re-runs the clamp after the open-effect reset
	useEffect(() => {
		setActiveIndex(current => {
			if (resultCount === 0) return 0;
			const clamped = Math.min(Math.max(current, 0), resultCount - 1);
			if (!sidecarBlocked(flatList[clamped], sidecarReady)) return clamped;
			// Never rest on a disabled row: Enter would otherwise be a no-op.
			const first = flatList.findIndex(item => !sidecarBlocked(item, sidecarReady));
			return first === -1 ? clamped : first;
		});
	}, [resultCount, flatList, open, sidecarReady]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	if (!open) return null;

	let flatIndex = -1;
	const activeItem = flatList[activeIndex];
	const armedMessage =
		armed && activeItem?.name === armed
			? t(commandGuard(activeItem) === "destructive" ? "palette.confirmDestructive" : "palette.confirmTurn")
			: "";
	const sectionHeaderClass = "px-2.5 pt-3 pb-1 text-sc-xs font-medium text-(--sc-text-muted) select-none";

	const renderItem = (item: CommandMenuItem, options?: { categoryLabel?: string }) => {
		flatIndex++;
		const index = flatIndex;
		const isActive = index === activeIndex;
		const blocked = sidecarBlocked(item, sidecarReady);
		const disabled = item.affordance.kind === "unavailable" || blocked;
		const isSubmenu = item.affordance.kind === "submenu";
		const toggleOn = item.affordance.kind === "toggle" ? item.affordance.get() : null;
		const isArmed = isActive && armed === item.name;
		// Submenu rows carry a placeholder category: show their parent's icon.
		const Icon = CATEGORY_ICON[submenu?.category ?? item.category];

		const detail = isArmed
			? armedMessage
			: disabled
				? item.affordance.kind === "unavailable"
					? item.affordance.reason
					: t("common.notConnected")
				: item.description;

		return (
			<OptionRow
				active={isActive}
				aria-disabled={disabled}
				data-active={isActive ? "true" : undefined}
				data-palette-index={index}
				data-command-name={item.name}
				data-command-aliases={JSON.stringify(item.aliases ?? [])}
				data-command-kind={item.affordance.kind}
				disabled={disabled}
				id={`${listboxId}-option-${index}`}
				key={item.name}
				onClick={() => execute(item)}
				onMouseEnter={() => {
					if (index === activeIndex) return;
					// Hover moves the highlight but is not an explicit pick for Enter.
					setActiveIndex(index);
					setExplicitSelection(false);
					setArmed(null);
				}}
			>
				<Icon aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				{/* Labels stay readable at narrow widths; supporting copy wraps onto a quiet second line. */}
				<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
					<span className="max-w-full shrink-0 truncate text-sc-md font-medium text-(--sc-text)">
						<HighlightedLabel label={item.label} query={query} />
					</span>
					{toggleOn !== null && (
						<span
							className={cx(
								"shrink-0 text-sc-2xs font-medium",
								toggleOn ? "text-(--sc-success)" : "text-(--sc-text-subtle)",
							)}
						>
							{toggleOn ? t("palette.on") : t("palette.off")}
						</span>
					)}
					{detail && (
						<span
							className={cx(
								"min-w-0 text-sc-sm",
								isArmed ? "basis-full text-(--sc-warning)" : "flex-1 basis-32 truncate text-(--sc-text-muted)",
							)}
						>
							{detail}
						</span>
					)}
				</span>
				{isArmed && <TriangleAlert aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-warning)" />}
				{options?.categoryLabel && (
					<span className="shrink-0 text-sc-xs text-(--sc-text-subtle)">{options.categoryLabel}</span>
				)}
				{item.shortcut && <Kbd shortcut={item.shortcut} />}
				{isSubmenu && <ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />}
			</OptionRow>
		);
	};

	return (
		<Modal
			ariaLabel={t("palette.searchLabel")}
			bodyClassName="flex flex-col p-0"
			chromeless
			// Escape inside a submenu steps back to the root list before it closes.
			onClose={submenu ? leaveSubmenu : close}
			open
			placement="top"
			size="picker"
		>
			<div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					{submenu && (
						<button
							aria-label={`${t("palette.hintBack")}: ${submenu.label}`}
							className="flex shrink-0 items-center gap-1 rounded-(--sc-radius-sm) px-1.5 py-0.5 text-sc-sm font-medium text-(--sc-accent) hover:bg-(--sc-hover)"
							onClick={leaveSubmenu}
							type="button"
						>
							<X aria-hidden className="size-(--sc-icon-sm)" />
							{submenu.label}
						</button>
					)}
					<div className="min-w-0 flex-1">
						<SearchField
							aria-activedescendant={flatList.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
							aria-controls={listboxId}
							controlSize="lg"
							label={t("palette.searchLabel")}
							onValueChange={value => {
								setQuery(value);
								resetSelection();
							}}
							placeholder={submenu ? t("palette.searchSubmenu", { name: submenu.label }) : t("palette.search")}
							ref={inputRef}
							value={query}
						/>
					</div>
					{loading && <Spinner size="sm" />}
				</div>
				{commandsError !== null && (
					<InlineNotice
						action={
							<Button onClick={refreshCommands} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						}
						className="border-b border-(--sc-divider) px-3.5 py-1.5"
						detail={commandsError.cause}
						live
						title={commandsError.message}
						tone="danger"
					/>
				)}
				<div
					aria-label={flatList.length > 0 ? t("palette.results") : undefined}
					className="omp-command-list min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					// A listbox only while option rows render; the empty states are plain blocks.
					role={flatList.length > 0 ? "listbox" : undefined}
				>
					{flatList.length === 0 &&
						!loading &&
						(workingItems.length === 0 ? (
							<EmptyState icon={<Search />} size="sm" title={t("palette.noCommands")} />
						) : (
							<EmptyState icon={<Search />} size="sm" title={t("palette.noMatch")} />
						))}

					{grouped ? (
						<>
							{recentItems.length > 0 && (
								<div aria-label={t("palette.recent")} className="mb-1" role="group">
									<div aria-hidden className={sectionHeaderClass}>
										{t("palette.recent")}
									</div>
									{recentItems.map(item => renderItem(item))}
								</div>
							)}
							{Array.from(grouped.entries()).map(([category, items]) => (
								<div aria-label={t(`category.${category}`)} className="mb-1" key={category} role="group">
									<div aria-hidden className={sectionHeaderClass}>
										{t(`category.${category}`)}
									</div>
									{items.map(item => renderItem(item))}
								</div>
							))}
						</>
					) : (
						flatList.map(item =>
							renderItem(item, submenu ? undefined : { categoryLabel: t(`category.${item.category}`) }),
						)
					)}
				</div>
				<div className="omp-palette-hints flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--sc-divider) px-4 py-3 text-sc-xs text-(--sc-text-muted)">
					<span className="flex items-center gap-1.5">
						<Kbd shortcut="↑" />
						<Kbd shortcut="↓" />
						{t("palette.hintMove")}
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd shortcut="↵" />
						{t("palette.hintRun")}
					</span>
					{submenu && (
						<span className="flex items-center gap-1.5">
							<Kbd shortcut="←" />
							{t("palette.hintBack")}
						</span>
					)}
					<span className="ml-auto flex items-center gap-1.5">
						<Kbd shortcut="⎋" />
						{t("palette.hintClose")}
					</span>
				</div>
				<div aria-live="polite" className="sr-only" role="status">
					{armedMessage}
				</div>
			</div>
		</Modal>
	);
}
