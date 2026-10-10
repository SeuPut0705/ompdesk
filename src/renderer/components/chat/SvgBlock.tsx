/**
 * SVG figures in the transcript: ```svg fences in assistant replies and
 * written .svg files. The picture is a sanitized `data:` URL `<img>`
 * (lib/svg-preview.ts) on a neutral chip, zoomable on click; a Code/Preview
 * switch shows the source. Source that does not parse as an SVG document —
 * a fence still streaming, a broken file — shows as code until it does.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_HEIGHT_LG } from "../../lib/preview";
import { SVG_PALETTE_VARIABLES, type SvgPalette, sanitizeSvg, svgDataUrl } from "../../lib/svg-preview";
import { Tabs } from "../common/Tabs";
import { ZoomableImage } from "../common/ZoomableImage";
import { CodeBlock } from "./CodeBlock";

function readPalette(): SvgPalette | undefined {
	if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return undefined;
	const style = window.getComputedStyle(document.documentElement);
	const palette: Record<string, string> = {};
	for (const [token, variable] of Object.entries(SVG_PALETTE_VARIABLES)) {
		const value = style.getPropertyValue(variable).trim();
		if (value) palette[token] = value;
	}
	return palette.fg ? palette : undefined;
}

/**
 * The app theme's figure colors, re-read when the theme changes (applyTheme
 * flips `data-theme` and rewrites the custom-property overrides on <html>).
 */
function useSvgPalette(): SvgPalette | undefined {
	const [palette, setPalette] = useState(readPalette);
	useEffect(() => {
		if (typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(() => {
			const next = readPalette();
			setPalette(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "style", "class"],
		});
		return () => observer.disconnect();
	}, []);
	return palette;
}

/** `code` as a sanitized, theme-resolved SVG document; null while it does not parse. */
export function useSanitizedSvg(code: string): string | null {
	const palette = useSvgPalette();
	return useMemo(() => sanitizeSvg(code, palette), [code, palette]);
}

/** A sanitized SVG document on a neutral chip, bounded in height and zoomable. */
export function SvgImage({ svg, className }: { svg: string; className?: string }) {
	const t = useT();
	const src = useMemo(() => svgDataUrl(svg), [svg]);
	return (
		<div
			className={cx(
				"flex justify-center overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-1) p-3",
				className,
			)}
			data-svg-preview
		>
			<ZoomableImage alt={t("svgPreview.image")} className={`${PREVIEW_HEIGHT_LG} h-auto max-w-full`} src={src} />
		</div>
	);
}

export type PreviewMode = "preview" | "code";

/** The Preview/Code switch shared by the svg fence, the Write card and their kin. */
export function PreviewModeTabs({ mode, onChange }: { mode: PreviewMode; onChange: (mode: PreviewMode) => void }) {
	const t = useT();
	return (
		<Tabs
			activeId={mode}
			ariaLabel={t("svgPreview.mode")}
			compact
			onChange={id => onChange(id === "code" ? "code" : "preview")}
			tabs={[
				{ id: "preview", label: t("svgPreview.preview") },
				{ id: "code", label: t("svgPreview.code") },
			]}
			variant="segmented"
		/>
	);
}

export interface SvgBlockProps {
	/** SVG source from the fence. */
	code: string;
	showLineNumbers?: boolean;
	maxHeightClass?: string;
	className?: string;
}

/** An assistant ```svg fence: the picture with a Code switch, or code until the source parses. */
export const SvgBlock = memo(function SvgBlock({ code, showLineNumbers, maxHeightClass, className }: SvgBlockProps) {
	const svg = useSanitizedSvg(code);
	const [mode, setMode] = useState<PreviewMode>("preview");
	const source = (
		<CodeBlock code={code} language="svg" showLineNumbers={showLineNumbers} maxHeightClass={maxHeightClass} />
	);
	if (svg === null) return <div className={className}>{source}</div>;
	return (
		<div className={cx("flex flex-col items-start gap-1.5", className)} data-svg-block>
			<PreviewModeTabs mode={mode} onChange={setMode} />
			{mode === "preview" ? (
				<SvgImage svg={svg} className="self-stretch" />
			) : (
				<div className="self-stretch">{source}</div>
			)}
		</div>
	);
});
