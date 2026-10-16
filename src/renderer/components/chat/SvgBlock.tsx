/**
 * SVG figures in the transcript: ```svg fences in assistant replies and
 * written .svg files. The picture is a sanitized `data:` URL `<img>`
 * (lib/svg-preview.ts) on a neutral chip, zoomable on click; a Code/Preview
 * switch shows the source. Source that does not parse as an SVG document —
 * a fence still streaming, a broken file — shows as code until it does.
 *
 * A figure that leaves its width open (`viewBox` only, as models write them)
 * has no natural width as an image: in the shrink-to-fit thumbnail it would
 * lay out at 0×0. It fills the chip's width instead, as inline SVG would, its
 * height following the viewBox ratio up to a viewport share like stock's TUI.
 */
import { memo, type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { PREVIEW_HEIGHT_LG } from "../../lib/preview";
import { SVG_PALETTE_VARIABLES, type SvgPalette, sanitizeSvg, svgDataUrl, svgFillsWidth } from "../../lib/svg-preview";
import { ZoomableImage, type ZoomableImageHandle } from "../common/ZoomableImage";
import { CodeBlock } from "./CodeBlock";
import { Figure } from "./Figure";

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

/** A sanitized SVG document, bounded in height and zoomable; the figure's box around it comes from `Figure`. */
export function SvgImage({ svg, zoom }: { svg: string; zoom?: RefObject<ZoomableImageHandle | null> }) {
	const t = useT();
	const src = useMemo(() => svgDataUrl(svg), [svg]);
	const fills = useMemo(() => svgFillsWidth(svg), [svg]);
	return (
		<div className="flex justify-center p-3" data-svg-preview>
			<ZoomableImage
				alt={t("svgPreview.image")}
				className={fills ? "h-auto max-h-[80dvh] w-full" : `${PREVIEW_HEIGHT_LG} h-auto max-w-full`}
				handleRef={zoom}
				src={src}
				thumbClassName={fills ? "w-full" : undefined}
			/>
		</div>
	);
}

export interface SvgBlockProps {
	/** SVG source from the fence or the written file. */
	code: string;
	showLineNumbers?: boolean;
	maxHeightClass?: string;
	/** Header title when the figure is a file ("logo.svg"); "SVG" otherwise. */
	title?: string;
	/** Replaces the code view's CodeBlock (a write's diff), inside the same box. */
	codeView?: ReactNode;
	/** Shown instead of the figure while the source does not parse (default: the code block). */
	fallback?: ReactNode;
	className?: string;
}

/** An svg fence or written .svg: the picture with the code one icon away, or code until the source parses. */
export const SvgBlock = memo(function SvgBlock({
	code,
	showLineNumbers,
	maxHeightClass,
	title = "SVG",
	codeView,
	fallback,
	className,
}: SvgBlockProps) {
	const svg = useSanitizedSvg(code);
	if (svg === null) {
		return (
			<div className={className}>
				{fallback ?? (
					<CodeBlock
						code={code}
						language="svg"
						maxHeightClass={maxHeightClass}
						showLineNumbers={showLineNumbers}
						title={title}
					/>
				)}
			</div>
		);
	}
	return (
		<Figure
			className={className}
			code={code}
			codeView={codeView}
			download={{ src: svgDataUrl(svg), name: title === "SVG" ? "figure.svg" : title }}
			kind="svg"
			language="svg"
			maxHeightClass={maxHeightClass}
			preview={zoom => <SvgImage svg={svg} zoom={zoom} />}
			showLineNumbers={showLineNumbers}
			title={title}
			zoomable
		/>
	);
});
