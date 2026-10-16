import { extractImageDataUrls, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { asRecord, asString } from "../../../lib/wire-value";
import { ResultImages } from "../media/ResultImages";
import type { ToolRendererProps } from "../ToolCard";
import { KeyValueView, ToolResultBody, visibleToolArgs } from "./GenericRenderer";
import { JsonTree } from "./JsonTree";
import { metaTruncation, stripGeneratedOutputNotice, TruncationNote } from "./output-meta";
import { resultDetails } from "./result";

/** Registry prefix every minted MCP tool name carries (stock `MCP_TOOL_NAME_PREFIX`). */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * `mcp__<server>_<tool>` → server and tool, exactly as stock pi-tui
 * `tools/mcp.ts` `parseMCPToolName` splits it (first underscore after the
 * prefix). A renderer copy: the renderer cannot import stock;
 * McpRenderer.test.tsx pins it to stock's cases.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;
	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscore = rest.indexOf("_");
	if (underscore === -1) return null;
	return { server: rest.slice(0, underscore), tool: rest.slice(underscore + 1) };
}

/**
 * An MCP server's tool (stock pi-tui `tools/mcp.ts` `describeMCPResult`):
 * the arguments, the text body — a JSON tree when it parses, the error text on
 * failure — any images the server returned, the truncation notice, and the
 * server's `structuredContent` folded as a tree. `MCPToolDetails.rawContent`
 * and `mcpMeta` duplicate the body and stay hidden, as in stock.
 */
export function McpRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial && partialResult != null ? partialResult : result;
	const details = resultDetails(effective);
	const truncation = metaTruncation(details);
	const text = resultText(effective);
	const body = truncation ? stripGeneratedOutputNotice(text) : text;
	const provider = asString(details?.providerName);
	const structured = asRecord(details?.structuredContent);
	const images = extractImageDataUrls(effective);
	const shownArgs = visibleToolArgs(args);
	const failed = isError === true || details?.isError === true;
	return (
		<div className="flex flex-col gap-1.5" data-tool-mcp>
			{(provider || Object.keys(shownArgs).length > 0) && (
				<div className="flex flex-col gap-1">
					{provider && (
						<span className="w-fit rounded-(--sc-radius-sm) border border-(--sc-border) px-1 text-sc-xs text-(--sc-text-subtle)">
							{provider}
						</span>
					)}
					{Object.keys(shownArgs).length > 0 && <KeyValueView value={shownArgs} />}
				</div>
			)}
			{effective != null && (images.length === 0 || body.trim()) && <ToolResultBody isError={failed} text={body} />}
			<ResultImages images={images} livePreview={livePreview} />
			{truncation && <TruncationNote notice={truncation} />}
			{structured && Object.keys(structured).length > 0 && (
				<details>
					<summary className="cursor-pointer list-none text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-dim)] transition-colors hover:text-[var(--omp-text)]">
						{t("tools.mcp.structured")}
					</summary>
					<div className="mt-1">
						<JsonTree hideRootKeys={false} label={t("tools.mcp.structured")} value={structured} />
					</div>
				</details>
			)}
		</div>
	);
}
