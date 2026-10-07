import { ArrowDown } from "lucide-react";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { isTurnMeterEstimate, throughputTokensPerSecond, turnMeterTokens } from "../../lib/turn-meter";
import { useMessagesStore } from "../../stores/messages";

/**
 * Quiet output-token figure for a work-summary row: "↓ 12.4k · 86 tok/s" live,
 * "↓ 12.4k · avg 80 tok/s" once finished. An estimated count is marked "~"
 * (the tooltip says where the number comes from). Renders nothing without tokens.
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
		rate > 0
			? t(average ? "chat.meter.average" : "chat.meter.rate", {
					rate: rate < 10 ? rate.toFixed(1) : String(Math.round(rate)),
				})
			: null;
	return (
		<span
			className="omp-output-meter flex shrink-0 items-center gap-1 text-sc-xs tabular-nums text-(--sc-text-subtle)"
			title={t(estimated ? "chat.meter.estimatedTitle" : "chat.meter.reportedTitle")}
		>
			<ArrowDown aria-hidden className="size-3 shrink-0" />
			{`${estimated ? "~" : ""}${formatTokens(tokens)}`}
			{rateText ? <span>· {rateText}</span> : null}
		</span>
	);
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
