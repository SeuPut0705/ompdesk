import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { asRecord } from "../../../lib/wire-value";
import type { ToolRendererProps } from "../ToolCard";
import { JSON_TREE_MAX_DEPTH, JsonTree } from "./JsonTree";
import { resultBodyText, resultDetails } from "./result";
import { ToolTextPreview } from "./ToolTextPreview";

/**
 * Stock's `yield` ("Submit result", pi-tui `tools/yield.ts`): what a subagent
 * submitted, not the model-facing "Result submitted." reply. The section labels
 * or workpool item name the target; container data reports its size; string
 * data renders as markdown, anything else as a JSON tree. `details`
 * (`YieldDetails`, pi-coding-agent `tools/yield.ts`) carries the accepted data,
 * `status: "aborted"` + `error`, and `schemaOverridden`.
 */
export function YieldRenderer({ args, result, isError, isPartial }: ToolRendererProps) {
	const t = useT();
	const settled = !isPartial && result != null;
	const details = settled && !isError ? resultDetails(result) : undefined;
	const type = details?.type ?? args.type;
	const sections = Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : [];
	const data = details?.data !== undefined ? details.data : (args.data ?? undefined);
	let error = typeof args.error === "string" && args.error ? args.error : undefined;
	if (settled && isError) error = resultBodyText(result).trim() || t("tools.yield.failed");
	else if (details?.status === "aborted") {
		error =
			(typeof details.error === "string" && details.error) ||
			resultBodyText(result).trim() ||
			t("tools.yield.aborted");
	}
	const target =
		typeof args.key === "number" ? t("tools.yield.item", { key: args.key }) : sections.join(", ") || undefined;
	const record = asRecord(data);
	const size = Array.isArray(data)
		? t("tools.yield.items", { count: data.length, plural: data.length === 1 ? "" : "s" })
		: record
			? t("tools.yield.fields", {
					count: Object.keys(record).length,
					plural: Object.keys(record).length === 1 ? "" : "s",
				})
			: undefined;
	const note =
		settled && error === undefined && data === undefined
			? t(sections.length > 0 ? "tools.yield.lastTurnSection" : "tools.yield.lastTurn")
			: undefined;
	return (
		<div className="flex flex-col gap-1.5" data-tool-yield>
			{(target || size || details?.schemaOverridden === true) && (
				<div className="flex flex-wrap items-center gap-1.5 text-sc-xs text-(--sc-text-subtle)">
					{target && <span className="font-mono text-(--sc-text-muted)">{target}</span>}
					{size && <span className="tabular-nums">{size}</span>}
					{details?.schemaOverridden === true && (
						<span className="text-(--sc-warning)">{t("tools.yield.schemaOverridden")}</span>
					)}
				</div>
			)}
			{error !== undefined && <ToolTextPreview isError text={error} />}
			{typeof data === "string" ? (
				data.trim() ? (
					<div className="text-sc-sm">
						<MarkdownRenderer content={data} />
					</div>
				) : (
					<div className="text-sc-xs text-(--sc-text-subtle)">{t("tools.yield.empty")}</div>
				)
			) : data !== undefined ? (
				<JsonTree hideRootKeys={false} label={t("tools.yield.data")} openDepth={JSON_TREE_MAX_DEPTH} value={data} />
			) : null}
			{note && <div className="text-sc-xs text-(--sc-text-subtle)">{note}</div>}
		</div>
	);
}
