import { Monitor } from "lucide-react";
import { extractImageDataUrls, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CaptureResult } from "./CaptureResult";
import type { ToolRendererProps } from "./ToolCard";

/** Computer use: action description + screenshot. */
export function ComputerRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const coordinate = Array.isArray(args.coordinate) ? (args.coordinate as number[]).join(", ") : "";
	const text = typeof args.text === "string" ? args.text : "";
	const effective = isPartial ? (partialResult ?? result) : result;

	return (
		<CaptureResult
			livePreview={livePreview}
			icon={<Monitor size={12} className="shrink-0 text-[var(--omp-status-path)]" />}
			action={typeof args.action === "string" ? args.action : ""}
			screenshot={extractImageDataUrls(effective).at(-1)}
			screenshotAlt={t("tools.computer.captureAlt")}
			imageClass="max-h-64"
			text={resultText(effective)}
			isError={isError}
			pendingLabel={isPartial ? t("tools.computer.acting") : null}
		>
			{coordinate && <span className="text-[var(--omp-dim)]">({coordinate})</span>}
			{text && <span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]">“{text}”</span>}
		</CaptureResult>
	);
}
