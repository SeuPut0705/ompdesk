import { ArrowUpRight, BarChart3, GitFork, Minimize2, RotateCw } from "lucide-react";
import {
	type CSSProperties,
	type FocusEvent,
	type ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { RpcContextReportResult } from "../../../../shared/rpc-types";
import { useOverlayPresence } from "../../../hooks/use-overlay-presence";
import { buildCurrentCommandMenu } from "../../../lib/command-registry";
import { useCompactionPoints } from "../../../lib/compaction-limits";
import { type ContextTone, contextTone, contextUsageView } from "../../../lib/context-usage";
import { cx, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { openHandoffDialog } from "../../../stores/fork-handoff";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, Spinner, Tooltip } from "../../common";
import { popoverTabStops, tabOutOfPopover } from "../../common/popover-focus";
import { ComposerSheet } from "./ComposerSheet";
import { keepFocus } from "./keep-focus";

interface AnchorPosition {
	bottom?: number;
	left: number;
	top?: number;
	width: number;
}

interface UsageCategory {
	color: string;
	key: "messages" | "system" | "tools";
	tokens: number;
}

const POPOVER_WIDTH = 336;
const POPOVER_ESTIMATED_HEIGHT = 220;
const VIEWPORT_EDGE = 12;

function approximateTokens(tokens: number): string {
	return tokens > 0 ? `~${formatTokens(tokens)}` : "0";
}

/**
 * Compact context control beside Send, the same on every shell: a ring that fills with the used share of the window
 * and turns warning near the compaction point and danger at it (`contextTone`). Its numbers ("Context 62% · 124k /
 * 200k · compacts at 160k") are the accessible name and the tooltip, never text on the toolbar. A hover or a click or
 * Enter/Space reveals the native provider-anchored token breakdown without opening the full context-report modal
 * (the tooltip stays off while it shows: the breakdown says the same). Keyboard focus alone never opens it; an
 * Enter/Space open moves focus into the breakdown, Tab past its last control closes it and goes on to the next toolbar
 * control, Escape closes it and returns to the ring.
 */
export function ContextUsagePopover({ variant = "ring" }: { variant?: "ring" | "sheet" }) {
	/** The phone: the breakdown is a bottom sheet (no floating card, no hover) and the ring keeps the field's focus. */
	const sheet = variant === "sheet";
	const t = useT();
	const rpc = useTabRpc();
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sessionId = useSessionStore(state => state.sessionId);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const compacting = useSessionStore(state => state.isCompacting);
	const model = useModelStore(state => state.model);
	const modelSelector = model ? `${model.provider}/${model.id}` : null;
	const points = useCompactionPoints(sidecarReady, modelSelector);
	/** Stock's resolved auto-compaction trigger for this model, in tokens; absent while auto-compaction is off. */
	const compactAt = modelSelector ? points?.bySelector.get(modelSelector)?.tokens : undefined;
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [anchor, setAnchor] = useState<AnchorPosition | null>(null);
	const [report, setReport] = useState<RpcContextReportResult | null>(null);
	const [loadedKey, setLoadedKey] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<number | undefined>(undefined);
	const { mounted, closing } = useOverlayPresence(open);
	/** Opened with Enter or Space: focus moves into the breakdown once it is on screen (never on a hover or a focus). */
	const focusPanel = useRef(false);

	useEffect(() => {
		if (!mounted || !anchor || !focusPanel.current) return;
		focusPanel.current = false;
		const panel = popoverRef.current;
		(panel ? (popoverTabStops(panel)[0] ?? panel) : null)?.focus();
	}, [mounted, anchor]);

	const usageKey = contextUsage ? `${sessionId}:${contextUsage.tokens}:${contextUsage.contextWindow}` : "";

	const updateAnchor = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1024;
		const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 768;
		const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_EDGE * 2);
		const left = Math.max(VIEWPORT_EDGE, Math.min(rect.right - width, viewportWidth - width - VIEWPORT_EDGE));
		if (rect.top >= POPOVER_ESTIMATED_HEIGHT + VIEWPORT_EDGE) {
			setAnchor({ bottom: viewportHeight - rect.top + 10, left, width });
			return;
		}
		setAnchor({ left, top: rect.bottom + 10, width });
	}, []);

	const cancelScheduledClose = useCallback(() => {
		if (closeTimer.current !== undefined) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = undefined;
		}
	}, []);

	const reveal = useCallback(() => {
		cancelScheduledClose();
		updateAnchor();
		setOpen(true);
	}, [cancelScheduledClose, updateAnchor]);

	const dismiss = useCallback(() => {
		cancelScheduledClose();
		setOpen(false);
		setPinned(false);
		// Escape from inside the breakdown: the portaled panel is about to go, focus goes back to the ring.
		if (popoverRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
	}, [cancelScheduledClose]);

	const scheduleClose = useCallback(() => {
		if (pinned) return;
		cancelScheduledClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 120);
	}, [cancelScheduledClose, pinned]);

	useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

	/** Focus moving on to a control outside the ring and the breakdown closes it, pinned or not (Tab out of it). */
	const closeOnFocusOut = (event: FocusEvent<HTMLElement>) => {
		const next = event.relatedTarget as Node | null;
		if (buttonRef.current?.contains(next) || popoverRef.current?.contains(next)) return;
		if (next) dismiss();
		else scheduleClose();
	};

	useEffect(() => {
		if (!open || sheet) return;
		const onViewportChange = () => updateAnchor();
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
			dismiss();
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Claim the keypress: the app-wide Escape handler runs next on window and
			// would abort the active turn in the same keystroke that closed this popover.
			event.preventDefault();
			dismiss();
		};
		window.addEventListener("resize", onViewportChange);
		window.addEventListener("scroll", onViewportChange, true);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("resize", onViewportChange);
			window.removeEventListener("scroll", onViewportChange, true);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [sheet, dismiss, open, updateAnchor]);

	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs; nothing
	   inside reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!open || !sidecarReady || !usageKey || usageKey === loadedKey) return;
		let cancelled = false;
		setLoading(true);
		setError(false);
		void rpc
			.getContextReport()
			.then(response => {
				if (cancelled) return;
				if (response.success) {
					setReport(response.data as RpcContextReportResult);
					setLoadedKey(usageKey);
				} else {
					setError(true);
				}
			})
			.catch(() => {
				if (!cancelled) setError(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, loadedKey, open, sidecarReady, usageKey, rpc]);

	const breakdown = loadedKey === usageKey ? report?.breakdown : undefined;
	const view = contextUsageView(contextUsage, breakdown);
	const { capacityKnown, contextWindow, percent, remainingTokens, usedTokens } = view;
	const categories = useMemo<UsageCategory[]>(() => {
		if (!breakdown) return [];
		return [
			{
				color: "var(--sc-text-subtle)",
				key: "system",
				tokens: breakdown.systemPromptTokens + breakdown.systemContextTokens + breakdown.skillsTokens,
			},
			{ color: "var(--sc-info)", key: "tools", tokens: breakdown.systemToolsTokens },
			{ color: "var(--sc-accent)", key: "messages", tokens: breakdown.messagesTokens },
		].filter(category => category.tokens > 0) as UsageCategory[];
	}, [breakdown]);

	/** One action at a time: the registry's own `/compact` (maintenance guard, hydrate, toasts). */
	const compactNow = async () => {
		const compact = buildCurrentCommandMenu([]).find(item => item.name === "compact");
		if (compact?.affordance.kind !== "action") return;
		dismiss();
		try {
			await compact.affordance.run();
		} catch (cause) {
			toastError({ title: t("contextUsage.compactFailed"), error: cause });
		}
	};

	if (!contextUsage) return null;

	const tone = contextTone(view, compactAt);
	const used = formatTokens(usedTokens);
	const capacity = formatTokens(contextWindow);
	const percentRounded = Math.round(percent);
	const label = !capacityKnown
		? t("contextUsage.ringUnknown", { used })
		: compactAt
			? t("contextUsage.ringCompacts", {
					percent: percentRounded,
					used,
					window: capacity,
					point: formatTokens(compactAt),
				})
			: t("contextUsage.ring", { percent: percentRounded, used, window: capacity });

	const popoverStyle: CSSProperties | undefined = anchor
		? { bottom: anchor.bottom, left: anchor.left, top: anchor.top, width: anchor.width }
		: undefined;

	const frame = (panel: ReactElement) =>
		sheet ? (
			<ComposerSheet label={t("contextUsage.title")} onClose={dismiss} open={open}>
				{panel}
			</ComposerSheet>
		) : (
			createPortal(panel, document.body)
		);

	return (
		<div
			className="relative shrink-0"
			onMouseEnter={sheet ? undefined : reveal}
			onMouseLeave={sheet ? undefined : scheduleClose}
		>
			<Tooltip content={label} describe={false} hidden={open}>
				<button
					{...(sheet ? keepFocus : {})}
					aria-controls={mounted ? "omp-context-usage-popover" : undefined}
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={label}
					className={cx(
						"omp-context-usage-trigger inline-flex h-(--sc-control-sm) min-w-0 items-center justify-center rounded-(--sc-radius-sm) px-1.5 transition-colors duration-(--sc-duration-instant)",
						open
							? "bg-(--sc-selected) text-(--sc-text)"
							: "text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text)",
					)}
					data-context-ring={tone}
					onBlur={sheet ? undefined : closeOnFocusOut}
					onClick={event => {
						if (sheet) {
							if (open) dismiss();
							else reveal();
							return;
						}
						if (open && pinned) {
							dismiss();
							return;
						}
						reveal();
						setPinned(true);
						// Enter or Space (a click without a pointer): the keyboard user's focus goes into the breakdown.
						if (event.detail === 0) focusPanel.current = true;
					}}
					ref={buttonRef}
					type="button"
				>
					<ContextRing percent={capacityKnown ? percent : null} tone={tone} />
				</button>
			</Tooltip>

			{(sheet ? open : mounted && anchor) &&
				frame(
					<div
						aria-hidden={closing || undefined}
						aria-label={sheet ? undefined : t("contextUsage.title")}
						className={cx(
							sheet
								? "px-3 pt-1 pb-1 break-keep text-(--sc-text)"
								: "fixed z-(--sc-z-popover) rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) px-4 pt-4 pb-2 break-keep text-(--sc-text) shadow-(--sc-shadow-md)",
							!sheet && (closing ? "omp-scale-out pointer-events-none" : "omp-pop-in"),
						)}
						id="omp-context-usage-popover"
						inert={closing}
						onBlur={sheet ? undefined : closeOnFocusOut}
						onFocus={sheet ? undefined : cancelScheduledClose}
						onKeyDown={event => {
							const panel = popoverRef.current;
							if (panel && tabOutOfPopover(event, panel, buttonRef.current)) dismiss();
						}}
						onMouseEnter={sheet ? undefined : cancelScheduledClose}
						onMouseLeave={sheet ? undefined : scheduleClose}
						ref={popoverRef}
						role={sheet ? undefined : pinned ? "dialog" : "group"}
						style={sheet ? undefined : popoverStyle}
					>
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-sc-md font-medium text-(--sc-text)">
								{t("contextUsage.title")}{" "}
								{capacityKnown && (
									<strong className="ml-1 font-semibold text-(--sc-text)">{`${Math.round(percent)}%`}</strong>
								)}
							</span>
							<span className="shrink-0 text-sc-md font-semibold tabular-nums">
								{capacityKnown
									? `${approximateTokens(usedTokens)} / ${formatTokens(contextWindow)}`
									: approximateTokens(usedTokens)}
							</span>
						</div>
						{capacityKnown && compactAt !== undefined && (
							<p className="mt-1 text-sc-xs text-(--sc-text-muted)" data-context-compacts>
								{t("contextUsage.compactsAt", { point: formatTokens(compactAt) })}
							</p>
						)}

						{capacityKnown && (
							<div
								aria-label={t("contextUsage.progress", { percent: Math.round(percent) })}
								aria-valuemax={100}
								aria-valuemin={0}
								aria-valuenow={Math.round(percent)}
								aria-valuetext={`${formatTokens(usedTokens)} ${t("contextUsage.used")}, ${formatTokens(remainingTokens)} ${t("contextUsage.remaining")}`}
								className="mt-3 flex h-1.5 overflow-hidden rounded-(--sc-radius-full) bg-(--sc-surface-3)"
								role="progressbar"
							>
								{categories.length > 0 ? (
									categories.map(category => (
										<span
											aria-hidden="true"
											key={category.key}
											style={{
												backgroundColor: category.color,
												width: `${Math.min(100, (category.tokens / contextWindow) * 100)}%`,
											}}
										/>
									))
								) : (
									<span aria-hidden="true" className="bg-(--sc-accent)" style={{ width: `${percent}%` }} />
								)}
							</div>
						)}

						{capacityKnown ? (
							<dl className="mt-3 grid grid-cols-2 gap-2">
								<div className="rounded-(--sc-radius-md) bg-(--sc-surface-2) px-2.5 py-2">
									<dt className="text-sc-xs text-(--sc-text-muted)">{t("contextUsage.used")}</dt>
									<dd className="text-sc-md font-semibold tabular-nums">{formatTokens(usedTokens)}</dd>
								</div>
								<div className="rounded-(--sc-radius-md) bg-(--sc-surface-2) px-2.5 py-2">
									<dt className="text-sc-xs text-(--sc-text-muted)">{t("contextUsage.remaining")}</dt>
									<dd className="text-sc-md font-semibold tabular-nums">{formatTokens(remainingTokens)}</dd>
								</div>
							</dl>
						) : (
							<div className="mt-3 rounded-(--sc-radius-md) bg-(--sc-surface-2) px-2.5 py-2 text-sc-sm text-(--sc-text-muted)">
								{t("contextUsage.windowUnknown")}
							</div>
						)}

						{loading && categories.length === 0 ? (
							<Spinner className="py-5" label={t("contextUsage.loading")} size="sm" />
						) : error && categories.length === 0 ? (
							<div className="flex flex-col items-start gap-2 py-4">
								<p role="alert" className="text-sc-sm text-(--sc-text-muted)">
									{t("contextUsage.unavailable")}
								</p>
								<Button
									icon={<RotateCw aria-hidden />}
									onClick={() => setAttempt(count => count + 1)}
									size="sm"
									variant="secondary"
								>
									{t("common.retry")}
								</Button>
							</div>
						) : (
							<div className="mt-3 space-y-2">
								{categories.map(category => (
									<div className="flex items-center gap-2.5" key={category.key}>
										<span
											aria-hidden="true"
											className="size-2.5 shrink-0 rounded-(--sc-radius-xs)"
											style={{ backgroundColor: category.color }}
										/>
										<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-secondary)">
											{t(`contextUsage.category.${category.key}`)}
										</span>
										<span className="shrink-0 text-sc-sm tabular-nums">
											{approximateTokens(category.tokens)}
										</span>
									</div>
								))}
							</div>
						)}
						<p className="mt-3 text-sc-xs text-(--sc-text-muted)">{t("contextUsage.baselineHint")}</p>
						<div
							className={
								sheet
									? "-mx-1 mt-3 flex flex-col gap-0.5 border-t border-(--sc-divider) pt-2"
									: "-mx-4 mt-3 flex flex-wrap gap-1 border-t border-(--sc-divider) px-2 pt-2"
							}
							data-context-actions
						>
							<Button
								className={sheet ? "min-h-(--sc-row-action) w-full justify-start" : undefined}
								disabled={compacting || !sidecarReady}
								icon={<Minimize2 aria-hidden className="text-(--sc-text-muted)" />}
								loading={compacting}
								onClick={() => void compactNow()}
								size="sm"
								variant="ghost"
							>
								{t("contextUsage.compact")}
							</Button>
							<Button
								className={sheet ? "min-h-(--sc-row-action) w-full justify-start" : undefined}
								disabled={compacting || !sidecarReady}
								icon={<GitFork aria-hidden className="text-(--sc-text-muted)" />}
								onClick={() => {
									dismiss();
									openHandoffDialog();
								}}
								size="sm"
								variant="ghost"
							>
								{t("contextUsage.handoff")}
							</Button>
							<Button
								className={cx("w-full justify-start", sheet && "min-h-(--sc-row-action)")}
								icon={<BarChart3 aria-hidden className="text-(--sc-text-muted)" />}
								onClick={() => {
									dismiss();
									useUiStore.getState().openInsights("stats", "session");
								}}
								size="sm"
								trailingIcon={<ArrowUpRight aria-hidden className="ml-auto text-(--sc-text-subtle)" />}
								variant="ghost"
							>
								{t("contextUsage.fullReport")}
							</Button>
						</div>
					</div>,
				)}
		</div>
	);
}

const RING_TONE: Record<ContextTone, string> = {
	unknown: "text-(--sc-text-muted)",
	ok: "text-(--sc-text-secondary)",
	warning: "text-(--sc-warning)",
	danger: "text-(--sc-danger)",
};

/**
 * The composer's context meter glyph: a ring whose arc is the used share of the window, coloured by `tone`. No known
 * capacity draws the empty track only — a share would be invented. The arc and colour ease to a new value once
 * (`.omp-context-ring` in components.css); nothing loops, and reduced motion or software compositing jumps.
 */
function ContextRing({ percent, tone }: { percent: number | null; tone: ContextTone }) {
	const radius = 5.5;
	const circumference = 2 * Math.PI * radius;
	const filled = percent === null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	return (
		<svg
			aria-hidden
			className={cx("omp-context-ring size-(--sc-icon-md) shrink-0 -rotate-90", RING_TONE[tone])}
			viewBox="0 0 14 14"
		>
			{/* The track must read as a gauge, not a loading spinner: a solid ring
			    under the fill, at full border contrast. */}
			<circle cx="7" cy="7" fill="none" r={radius} stroke="var(--sc-border)" strokeWidth="2" />
			<circle
				cx="7"
				cy="7"
				data-context-arc={percent === null ? undefined : Math.round(percent)}
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeDasharray={`${filled} ${circumference}`}
				strokeLinecap={filled > 0 ? "round" : "butt"}
				strokeWidth="2"
			/>
		</svg>
	);
}
