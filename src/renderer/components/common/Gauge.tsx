/**
 * Gauge: one bar of a known fullness with its name inside on the left and its value inside on the right, and an
 * optional muted caption line under it (a usage window's reset, a pool's oldest wait). For a measured whole that is
 * not progress and not a share split: `UsageGauges` draws every account window with it ("5H 62%"), the sidebar's
 * Checks block draws every pool's slots ("GitHub macOS 5/5"). The fill is `fraction` (0..1, clamped) as a low wash
 * of the text colour, so one text colour reads over the fill and the track; `state` tints it: `near` warning,
 * `limit` danger, `ok` (default) neutral. A full pool is `near`, not `limit`: pick `limit` only for a real error.
 *
 * The bar is the progressbar: `ariaLabel` names it with its value in words (the glyphs inside are hidden from
 * assistive tech), `ariaValueText` defaults to `valueText`. `data-*` attributes reach the gauge's root; the label and
 * the value take their own through `labelAttrs`/`valueAttrs`. The caption is drawn only when given; `captionLabel`
 * makes it an image named so (and its tooltip), for a glyph line ("↻ 1h 54m") that needs its full sentence. The
 * classes keep the `omp-usage-gauge*` names the usage gauges' styles, tests and e2e selectors already use.
 */
import type { ReactNode } from "react";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export type GaugeState = "ok" | "near" | "limit";

export interface GaugeProps extends DataAttributes {
	label: string;
	valueText: string;
	/** How full, 0..1; outside the range it is clamped. */
	fraction: number;
	state?: GaugeState;
	/** The bar's accessible name, with its value in words. */
	ariaLabel: string;
	ariaValueText?: string;
	caption?: ReactNode;
	/** The caption's full text, as its accessible name and tooltip. */
	captionLabel?: string;
	labelAttrs?: DataAttributes;
	valueAttrs?: DataAttributes;
}

export function Gauge({
	label,
	valueText,
	fraction,
	state = "ok",
	ariaLabel,
	ariaValueText,
	caption,
	captionLabel,
	labelAttrs,
	valueAttrs,
	...rest
}: GaugeProps) {
	const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100);
	return (
		<span {...rest} className="omp-usage-gauge" data-state={state}>
			<span
				aria-label={ariaLabel}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={percent}
				aria-valuetext={ariaValueText ?? valueText}
				className="omp-usage-gauge-bar"
				role="progressbar"
			>
				<span className="omp-usage-gauge-fill" style={{ transform: `scaleX(${percent / 100})` }} />
				<span aria-hidden className="omp-usage-gauge-text">
					<span {...labelAttrs}>{label}</span>
					<span {...valueAttrs}>{valueText}</span>
				</span>
			</span>
			{caption === undefined || caption === null || caption === false ? null : captionLabel ? (
				<span aria-label={captionLabel} className="omp-usage-gauge-reset" role="img" title={captionLabel}>
					{caption}
				</span>
			) : (
				<span className="omp-usage-gauge-reset">{caption}</span>
			)}
		</span>
	);
}
