import { useEffect, useMemo, useState } from "react";
import { STREAM_FORMAT_FLUSH_MS, useThrottledText } from "../../hooks/use-throttled-text";
import { useDisplayPreference } from "../../lib/display-preferences";
import { durationBetween, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { motionAllowed } from "../../lib/motion";
import {
	formatThinkingForDisplay,
	hasDisplayableThinking,
	THINKING_GLYPH_FRAMES,
	thinkingGlyphFrameDelay,
} from "../../lib/thinking";
import { useMessagesStore } from "../../stores/messages";
import { useUiStore } from "../../stores/ui";
import { Collapse, DisclosureButton, LiveText } from "../common";
import { formatTokenRate } from "./TurnOutputMeter";

export interface ThinkingBlockProps {
	/** Finalized thinking text (from a completed message). */
	text?: string;
	/** Render the live streamingThinking buffer instead of `text`. */
	live?: boolean;
	/** Start/end (epoch ms or ISO) for the duration meta. */
	startTime?: number | string;
	endTime?: number | string;
}

/**
 * Collapsible reasoning trace, kept quiet so the answer stays the most
 * prominent thing in the turn (TUI parity for the content rules):
 * - `proseOnlyThinking` elides fenced code to a `...` placeholder and drops
 *   empty `<!-- -->` summary sentinels (formatThinkingForDisplay port).
 * - `hideThinkingBlock` suppresses the block entirely; while reasoning is
 *   still streaming, an eased starburst pulse (✻✼❉…) shows in its place,
 *   ending once text output starts or the block finalizes.
 * - While live, the speed gauge uses the host's stock token-rate snapshot.
 *
 * Collapsed it is one muted row: chevron, "Thought", and the duration (or a
 * word count when no timing is known). Open state follows the
 * `thinkingExpanded` preference (settings store) until the user toggles it.
 */
export function ThinkingBlock({ text, live = false, startTime, endTime }: ThinkingBlockProps) {
	const t = useT();
	// Finalized blocks must not subscribe to the live buffer: every thinking
	// delta would re-render every mounted history block in the window.
	const streamingThinking = useMessagesStore(s => (live ? s.streamingThinking : ""));
	const streamingTextStarted = useMessagesStore(s => s.streamingText.length > 0);
	const tokensPerSecond = useMessagesStore(s => (live ? s.turnMeter.rate : null));
	const hideThinkingBlock = useDisplayPreference("hideThinkingBlock");
	const proseOnly = useDisplayPreference("proseOnlyThinking");
	const thinkingExpanded = useUiStore(s => s.thinkingExpanded);
	const [open, setOpen] = useState(thinkingExpanded);
	// The Settings → GUI toggle applies to already-mounted blocks too; a manual
	// chevron click then overrides until the pref changes again.
	useEffect(() => setOpen(thinkingExpanded), [thinkingExpanded]);

	const content = live ? streamingThinking : (text ?? "");
	const isLive = live && content.length > 0;
	// Formatting, word counts, and Markdown parse share the reply-text cadence.
	// Previously a long reasoning stream reprocessed its entire growing prefix
	// on every 16 ms event batch, even while the block was collapsed.
	const displayContent = useThrottledText(content, live ? STREAM_FORMAT_FLUSH_MS : 0);
	const formatted = useMemo(() => formatThinkingForDisplay(displayContent, proseOnly), [displayContent, proseOnly]);
	const duration = durationBetween(startTime, endTime);

	// The hidden pulse mirrors the TUI: only while this block is still
	// streaming and the model is reasoning right now — once text output starts
	// or the block finalizes, hidden thinking renders nothing.
	const showPulse = hideThinkingBlock && isLive && !streamingTextStarted;

	const rate = isLive ? (tokensPerSecond ?? 0) : 0;
	const showGauge = isLive && rate >= 0.05;
	const gauge = showGauge ? (
		<span className="omp-thinking-gauge -ms-1 shrink-0 tabular-nums text-(--sc-text-subtle)">
			{"· "}
			{t("chat.meter.rate", { rate: formatTokenRate(rate) })}
		</span>
	) : null;

	// ── Hidden-thinking glyph pulse ─────────────────────────────────────────
	// A JS clock re-rendering this block, so it never starts where motion is off (reduced motion, software
	// compositing, a hidden window): the glyph then rests on its first frame.
	const [glyphFrame, setGlyphFrame] = useState(0);
	useEffect(() => {
		if (!showPulse || !motionAllowed()) return;
		let frame = 0;
		let timer = setTimeout(function tick() {
			if (motionAllowed()) {
				frame += 1;
				setGlyphFrame(frame);
			}
			timer = setTimeout(tick, thinkingGlyphFrameDelay(frame));
		}, thinkingGlyphFrameDelay(0));
		return () => clearTimeout(timer);
	}, [showPulse]);

	if (!content) return null;

	if (hideThinkingBlock) {
		if (!showPulse) return null;
		const glyph = THINKING_GLYPH_FRAMES[glyphFrame % THINKING_GLYPH_FRAMES.length] ?? "…";
		return (
			<div className="omp-thinking-block omp-thinking-block--pulse flex min-h-7 items-center gap-2 px-1.5 text-sc-sm text-(--sc-text-muted)">
				<span aria-hidden className="inline-block w-(--sc-icon-sm) text-center">
					{glyph}
				</span>
				<LiveText className="omp-thinking-state" state="turn" text={t("chat.thinking.live")} />
				{gauge}
			</div>
		);
	}

	if (!hasDisplayableThinking(content, formatted)) return null;

	const trimmed = formatted.trim();
	const words = trimmed ? trimmed.split(/\s+/).length : 0;
	const meta = isLive ? null : (duration ?? t("chat.thinking.words", { count: words.toLocaleString(uiLocale()) }));

	return (
		<div className="omp-thinking-block min-w-0">
			<DisclosureButton
				aria-label={t(open ? "chat.thinking.hide" : "chat.thinking.show")}
				chevronClassName="size-(--sc-icon-sm) text-(--sc-text-subtle)"
				className="omp-thinking-header min-h-7 min-w-0 rounded-(--sc-radius-sm) px-1.5 text-sc-sm text-(--sc-text-muted) transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) hover:text-(--sc-text-secondary) aria-expanded:text-(--sc-text-secondary)"
				inline
				onToggle={() => setOpen(v => !v)}
				open={open}
			>
				{isLive ? (
					<LiveText className="omp-thinking-state font-medium" state="turn" text={t("chat.thinking.live")} />
				) : (
					<span className="omp-thinking-state font-medium">{t("chat.thinking.done")}</span>
				)}
				{gauge}
				{meta ? (
					<span className="omp-thinking-meta -ms-1 shrink-0 tabular-nums text-(--sc-text-subtle)">· {meta}</span>
				) : null}
			</DisclosureButton>
			<Collapse className="flow-root" open={open}>
				<div className="omp-thinking-body text-sc-sm text-(--sc-text-muted)">
					{isLive ? (
						<div className="omp-streaming-tail">
							{formatted}
							<span aria-hidden className="omp-caret" />
						</div>
					) : (
						<MarkdownRenderer content={formatted} />
					)}
				</div>
			</Collapse>
		</div>
	);
}
