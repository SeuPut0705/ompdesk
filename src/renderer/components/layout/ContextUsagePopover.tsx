import { RotateCw } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RpcContextReportResult } from "../../../shared/rpc-types";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { contextUsageView, formatContextUsage } from "../../lib/context-usage";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Button, Spinner } from "../common";

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
 * Compact context control beside Send. The idle surface is one icon; hover,
 * focus or click reveals the native provider-anchored token breakdown without
 * opening the full context-report modal.
 */
export function ContextUsagePopover() {
	const t = useT();
	const rpc = useTabRpc();
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sessionId = useSessionStore(state => state.sessionId);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
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
	}, [cancelScheduledClose]);

	const scheduleClose = useCallback(() => {
		if (pinned) return;
		cancelScheduledClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 120);
	}, [cancelScheduledClose, pinned]);

	useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

	useEffect(() => {
		if (!open) return;
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
	}, [dismiss, open, updateAnchor]);

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

	if (!contextUsage) return null;

	const triggerLabel = capacityKnown
		? t("contextUsage.open", { percent: Math.round(percent) })
		: t("contextUsage.windowUnknown");

	const popoverStyle: CSSProperties | undefined = anchor
		? { bottom: anchor.bottom, left: anchor.left, top: anchor.top, width: anchor.width }
		: undefined;

	return (
		<div className="relative shrink-0" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
			<button
				aria-controls="omp-context-usage-popover"
				aria-expanded={open}
				aria-label={triggerLabel}
				className={cx(
					"omp-context-usage-trigger inline-flex h-(--sc-control-sm) min-w-0 items-center gap-1.5 rounded-(--sc-radius-sm) px-1.5 text-sc-xs font-medium tabular-nums transition-colors duration-(--sc-duration-instant)",
					open
						? "bg-(--sc-selected) text-(--sc-text)"
						: "text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text)",
				)}
				onBlur={scheduleClose}
				onClick={() => {
					if (open && pinned) {
						dismiss();
						return;
					}
					reveal();
					setPinned(true);
				}}
				onFocus={reveal}
				ref={buttonRef}
				type="button"
			>
				<ContextRing percent={capacityKnown ? percent : null} />
				<span className="omp-context-usage-label">
					{capacityKnown ? `${Math.round(percent)}%` : formatContextUsage(view)}
				</span>
			</button>

			{mounted &&
				anchor &&
				createPortal(
					<div
						aria-hidden={closing || undefined}
						aria-label={t("contextUsage.title")}
						className={cx(
							"fixed z-(--sc-z-popover) rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-4 text-(--sc-text) shadow-(--sc-shadow-md)",
							closing ? "omp-scale-out pointer-events-none" : "omp-pop-in",
						)}
						id="omp-context-usage-popover"
						inert={closing}
						onMouseEnter={cancelScheduledClose}
						onMouseLeave={scheduleClose}
						ref={popoverRef}
						role="group"
						style={popoverStyle}
					>
						<div className="flex items-baseline justify-between gap-4">
							<span className="text-sc-md text-(--sc-text-secondary)">
								{t("contextUsage.used")}{" "}
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
							<div className="flex items-center gap-2 py-5 text-sc-sm text-(--sc-text-muted)">
								<Spinner size="sm" />
								{t("contextUsage.loading")}
							</div>
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
						<Button
							className="mt-2 w-full"
							onClick={() => {
								dismiss();
								useUiStore.getState().openInsights("stats", "session");
							}}
							size="sm"
							variant="ghost"
						>
							{t("contextUsage.fullReport")}
						</Button>
					</div>,
					document.body,
				)}
		</div>
	);
}

/**
 * The composer's context meter glyph: a ring that fills with the share of the
 * context window in use, turning warning near the limit and danger at it. No
 * known capacity draws the empty track only — a share would be invented.
 */
function ContextRing({ percent }: { percent: number | null }) {
	const radius = 5.5;
	const circumference = 2 * Math.PI * radius;
	const filled = percent === null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	const tone =
		percent === null
			? "text-(--sc-text-muted)"
			: percent >= 95
				? "text-(--sc-danger)"
				: percent >= 80
					? "text-(--sc-warning)"
					: "text-(--sc-text-secondary)";
	return (
		<svg aria-hidden className={cx("size-(--sc-icon-sm) shrink-0 -rotate-90", tone)} viewBox="0 0 14 14">
			{/* The track must read as a gauge, not a loading spinner: a solid ring
			    under the fill, at full border contrast. */}
			<circle cx="7" cy="7" fill="none" r={radius} stroke="var(--sc-border)" strokeWidth="2" />
			<circle
				cx="7"
				cy="7"
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeDasharray={`${filled} ${circumference}`}
				strokeLinecap="round"
				strokeWidth="2"
			/>
		</svg>
	);
}
