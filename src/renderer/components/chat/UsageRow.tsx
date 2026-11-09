import { ArrowDown, ArrowUp, Clock, DollarSign, Zap } from "lucide-react";
import { useDisplayPreference } from "../../lib/display-preferences";
import { cx, formatDuration, formatTokens, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ModelLabel } from "../settings/ModelLabel";
import { compactModelLabel } from "../settings/providers/provider-marks";

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

interface MessageUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number | undefined;
}

/**
 * The usage slice UsageRow renders: a full finalized assistant message or the
 * narrower ReadGroupUsage carried by a read-group card. AgentMessage satisfies
 * it via its index signature; read-group.ts builds the slice directly.
 */
export interface UsageSource {
	role?: string;
	usage?: unknown;
	model?: string;
	/** Provider id the model ran on; absent on slices that only carry the bare model id. */
	provider?: string;
	duration?: number;
	ttft?: number;
	timestamp?: string | number;
}

/**
 * Narrow the pi-ai `usage` payload that rides on finalized assistant messages
 * (absent on other roles). Returns null when nothing billable was recorded —
 * aborted/errored turns carry an all-zero usage block not worth a row.
 */
function readUsage(message: UsageSource): MessageUsage | null {
	const usage = message.usage;
	if (usage == null || typeof usage !== "object") return null;
	const record = usage as Record<string, unknown>;
	const read = (key: string): number => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	};
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	let costTotal: number | undefined;
	const cost = record.cost;
	if (cost != null && typeof cost === "object") {
		const total = (cost as Record<string, unknown>).total;
		if (typeof total === "number" && Number.isFinite(total) && total > 0) costTotal = total;
	}
	if (input + output + cacheRead + cacheWrite <= 0 && costTotal === undefined) return null;
	return { input, output, cacheRead, cacheWrite, costTotal };
}

function formatCost(total: number): string {
	return `$${total >= 1 ? total.toFixed(2) : total.toPrecision(2)}`;
}

/**
 * The row is one line at any width (the owner's call, 9 Nov 2026: on a phone it stacked into two or three). As the row
 * narrows the model's name gives way to an ellipsis, and below each width here (em of the row's own text, so the
 * steps follow the font size) one more segment goes, least useful first: first-token time, throughput, cache, the
 * duration, then the input. The model, the output and the cost always stay. Each step is the sum of the segments still
 * shown, measured in English and Korean (input and output 3.4em, cache 7.1, cost 5.0, duration 3.9, first token 5.2,
 * throughput 6.3, plus a 1em gap each), and 6em for the model's mark and a few letters; longer numbers take that room
 * from the model's name. Every value stays in the row's tooltip.
 *
 * Nothing is said twice (the owner, 10 Nov 2026): the message time stays out of the row, the reply's actions right
 * below show it, and the first-token time goes when it reads the same as the duration.
 */
const DROP = {
	ttft: "@max-[48em]/usage:hidden",
	rate: "@max-[41em]/usage:hidden",
	cache: "@max-[34em]/usage:hidden",
	duration: "@max-[26em]/usage:hidden",
	input: "@max-[21em]/usage:hidden",
} as const;

/** A segment beside the model: it never shrinks, the model's name gives way instead. */
const SEGMENT = "flex shrink-0 items-center gap-1";

/**
 * Compact usage/cost footer under completed assistant messages (TUI
 * usage-row.ts parity): model, in/out tokens, cache reads, cost, wall-clock
 * duration, and throughput — only the segments the message actually carries.
 * Accepts a full AgentMessage or the narrower usage slice carried by a read
 * group card (read-group.ts ReadGroupUsage).
 */
export function UsageRow({ message }: { message: UsageSource }) {
	const t = useT();
	// Honors the shared `display.showTokenUsage` setting (schema default off) —
	// previously the GUI ignored it and always rendered usage.
	const showTokenUsage = useDisplayPreference("showTokenUsage");
	if (!showTokenUsage) return null;
	if (message.role !== "assistant") return null;
	const usage = readUsage(message);
	if (!usage) return null;

	const model = typeof message.model === "string" ? message.model : "";
	const provider = typeof message.provider === "string" ? message.provider : "";
	const durationMs = typeof message.duration === "number" && Number.isFinite(message.duration) ? message.duration : 0;
	const ttftMs = typeof message.ttft === "number" && Number.isFinite(message.ttft) ? message.ttft : 0;
	const totalInput = usage.input + usage.cacheWrite;
	const tokPerSec = durationMs > MIN_DURATION_MS && usage.output > 0 ? (usage.output / durationMs) * 1000 : 0;
	// Message time (TUI usage-row parity): the wire timestamp is an ISO string
	// or epoch ms; render a compact HH:MM.
	const timestampMs =
		typeof message.timestamp === "number"
			? message.timestamp
			: typeof message.timestamp === "string"
				? Date.parse(message.timestamp)
				: Number.NaN;
	const timeText = Number.isFinite(timestampMs)
		? (() => {
				const date = new Date(timestampMs);
				const hours = String(date.getHours()).padStart(2, "0");
				const minutes = String(date.getMinutes()).padStart(2, "0");
				return `${hours}:${minutes}`;
			})()
		: "";

	const rateText = tokPerSec > 0 ? t("chat.meter.rate", { rate: tokPerSec.toFixed(1) }) : "";
	const durationText = durationMs > 0 ? formatDuration(durationMs) : "";
	const ttftText = ttftMs > 0 ? formatDuration(ttftMs) : "";
	// Every value with its name, also those the row's width left out.
	const details = [
		model && (provider ? `${provider}/${model}` : model),
		t("chat.usage.inputTokens", { count: totalInput.toLocaleString(uiLocale()) }),
		t("chat.usage.outputTokens", { count: usage.output.toLocaleString(uiLocale()) }),
		usage.cacheRead > 0 && t("chat.usage.cachedTokens", { count: usage.cacheRead.toLocaleString(uiLocale()) }),
		usage.costTotal !== undefined && `${t("chat.usage.cost")}: ${formatCost(usage.costTotal)}`,
		durationText && `${t("chat.usage.duration")}: ${durationText}`,
		ttftText && `${t("chat.usage.ttft")}: ${ttftText}`,
		rateText && `${t("chat.usage.throughput")}: ${rateText}`,
		timeText && `${t("chat.usage.time")}: ${timeText}`,
	]
		.filter(Boolean)
		.join("\n");

	return (
		<div
			className="omp-usage-row @container/usage mt-1.5 text-sc-xs tabular-nums text-(--sc-text-subtle)"
			title={details}
		>
			<div className="flex items-center gap-x-3 overflow-hidden whitespace-nowrap [&_svg]:size-(--sc-icon-sm) [&_svg]:shrink-0">
				{model && (
					<span className="flex min-w-0" data-usage-segment="model">
						<ModelLabel provider={provider} label={compactModelLabel({ provider, id: model })} />
					</span>
				)}
				<span className={cx(SEGMENT, DROP.input)} data-usage-segment="input">
					<ArrowUp aria-hidden />
					{formatTokens(totalInput)}
				</span>
				<span className={SEGMENT} data-usage-segment="output">
					<ArrowDown aria-hidden />
					{formatTokens(usage.output)}
				</span>
				{usage.cacheRead > 0 && (
					<span className={cx(SEGMENT, DROP.cache)} data-usage-segment="cache">
						{t("chat.usage.cached", { tokens: formatTokens(usage.cacheRead) })}
					</span>
				)}
				{usage.costTotal !== undefined && (
					<span className={SEGMENT} data-usage-segment="cost">
						<DollarSign aria-hidden />
						{formatCost(usage.costTotal)}
					</span>
				)}
				{durationText && (
					<span className={cx(SEGMENT, DROP.duration)} data-usage-segment="duration">
						<Clock aria-hidden />
						{durationText}
					</span>
				)}
				{ttftText && ttftText !== durationText && (
					<span className={cx(SEGMENT, DROP.ttft)} data-usage-segment="ttft">
						TTFT {ttftText}
					</span>
				)}
				{rateText && (
					<span className={cx(SEGMENT, DROP.rate)} data-usage-segment="rate">
						<Zap aria-hidden />
						{rateText}
					</span>
				)}
			</div>
		</div>
	);
}
