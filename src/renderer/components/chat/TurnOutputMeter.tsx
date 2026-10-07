import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { isTurnMeterEstimate, throughputTokensPerSecond, turnMeterTokens } from "../../lib/turn-meter";
import { useMessagesStore } from "../../stores/messages";

/**
 * Quiet output-token figure for a work-summary row, in words rather than
 * glyphs: "12.4k tokens · 86/s" live, "12.4k tokens · avg 80/s" once
 * finished. An estimated count reads "~12.4k tokens" (the tooltip says where
 * the number comes from). Renders nothing without tokens.
 */
export function OutputMeter({
	average = false,
	estimated,
	rate,
	tokens,
}: {
	average?: boolean;
	estimated: boolean;
	rate: number;
	tokens: number;
}) {
	const t = useT();
	if (!(tokens > 0)) return null;
	const rateText =
		rate > 0 ? t(average ? "chat.meter.average" : "chat.meter.rate", { rate: formatTokenRate(rate) }) : null;
	const count = formatTokens(tokens);
	return (
		<span
			className="omp-output-meter -ms-1 shrink-0 tabular-nums text-(--sc-text-subtle)"
			title={t(estimated ? "chat.meter.estimatedTitle" : "chat.meter.reportedTitle")}
		>
			{"· "}
			{t(estimated ? "chat.meter.tokensEstimated" : "chat.meter.tokens", { tokens: count })}
			{rateText ? ` · ${rateText}` : null}
		</span>
	);
}

/** One decimal below 10 tokens/s ("4.7"), whole numbers above ("63"). */
export function formatTokenRate(rate: number): string {
	return rate < 10 ? rate.toFixed(1) : String(Math.round(rate));
}

/** The running agent turn's meter (messages store `turnMeter`); hidden once the run ends. */
export function LiveTurnMeter() {
	const meter = useMessagesStore(s => s.turnMeter);
	const live = meter.startedAt != null && meter.endedAt == null;
	// The once-a-second tick re-renders so the windowed rate decays while no deltas arrive.
	useNowTick(live);
	if (!live) return null;
	return (
		<OutputMeter
			estimated={isTurnMeterEstimate(meter)}
			rate={throughputTokensPerSecond(meter.samples, Date.now())}
			tokens={turnMeterTokens(meter)}
		/>
	);
}
