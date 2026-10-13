import { Globe } from "lucide-react";
import { extractImageDataUrls, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CaptureResult } from "./CaptureResult";
import type { ToolRendererProps } from "./ToolCard";

/** Browser automation: action description + screenshot thumbnail when present. */
export function BrowserRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? (partialResult ?? result) : result;
	const details = resultDetails(effective);
	const action = typeof args.action === "string" ? args.action : typeof args.code === "string" ? args.code : "";
	const url = typeof details?.url === "string" ? details.url : typeof args.url === "string" ? args.url : "";

	return (
		<CaptureResult
			livePreview={livePreview}
			icon={<Globe size={12} className="shrink-0 text-[var(--omp-md-link)]" />}
			action={livePreview && url ? "" : action}
			screenshot={extractImageDataUrls(effective).at(-1)}
			screenshotAlt={t("tools.browser.screenshotAlt")}
			imageClass="max-h-56"
			text={resultText(effective)}
			isError={isError}
			pendingLabel={isPartial ? t("tools.browser.navigating") : null}
		>
			{url && <span className="min-w-0 flex-1 truncate text-[var(--omp-md-link)]">{url}</span>}
		</CaptureResult>
	);
}
