import { Check, MousePointer2 } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
	type AgentDesktopError,
	type AgentDesktopNode,
	agentDesktopNodes,
	parseAgentDesktopResult,
} from "../../../lib/agent-desktop";
import { agentDesktopSummary, isAgentDesktopNoMatch } from "../../../lib/agent-desktop-name";
import { extractImageDataUrls } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { asNumber, asRecord, asString } from "../../../lib/wire-value";
import { Collapse } from "../../common/Collapse";
import { DisclosureButton } from "../../common/DisclosureButton";
import { type TreeNode, TreeView } from "../../common/TreeView";
import { CaptureResult } from "../media/CaptureResult";
import type { ToolRendererProps } from "../ToolCard";
import { JsonTree } from "./JsonTree";
import { McpRenderer } from "./McpRenderer";
import { ToolTextPreview } from "./ToolTextPreview";

/** Levels open at first, as the JSON tree's: deeper rows are one click or arrow key away. */
const OPEN_DEPTH = 2;

/** A value past this many characters is clipped on its row (the raw result below holds it whole). */
const VALUE_CHARS = 60;

type Translate = ReturnType<typeof useT>;

function treeNodes(
	nodes: AgentDesktopNode[],
	parentId: string,
	depth: number,
	open: Set<string>,
	t: Translate,
): TreeNode[] {
	return nodes.map((node, index) => {
		const id = `${parentId}.${index}`;
		if (node.children.length > 0 && depth < OPEN_DEPTH) open.add(id);
		const value = node.value && node.value.length > VALUE_CHARS ? `${node.value.slice(0, VALUE_CHARS)}…` : node.value;
		// What agent-desktop did not read under this element: a count it took, or only that it stopped.
		const unread =
			node.unread !== undefined
				? t("tools.agentDesktop.unread", { count: node.unread })
				: node.truncated
					? t("tools.agentDesktop.cutShort")
					: undefined;
		return {
			id,
			label: (
				<span className="font-mono" data-agent-desktop-states={node.states.join(" ") || undefined}>
					<span className="text-[var(--omp-dim)]">{node.role}</span>
					{node.name && <span className="text-[var(--omp-success)]">{` "${node.name}"`}</span>}
					{value !== undefined && <span className="text-[var(--omp-muted)]">{` = "${value}"`}</span>}
					{node.ref && <span className="text-[var(--omp-accent)]">{` ${node.ref}`}</span>}
					{node.states.length > 0 && (
						<span className="text-[var(--omp-warning)]">{` [${node.states.join(", ")}]`}</span>
					)}
					{unread && (
						<span className="text-[var(--omp-dim)] italic" data-agent-desktop-unread>
							{` ${unread}`}
						</span>
					)}
				</span>
			),
			children: node.children.length > 0 ? treeNodes(node.children, id, depth + 1, open, t) : undefined,
		};
	});
}

/** The accessibility tree of a snapshot, a find or a window list: one line per element, deep levels folded. */
function ElementTree({ nodes, label }: { nodes: AgentDesktopNode[]; label: string }) {
	const t = useT();
	const built = useMemo(() => {
		const open = new Set<string>();
		return { rows: treeNodes(nodes, "$", 0, open, t), open };
	}, [nodes, t]);
	const [expanded, setExpanded] = useState(built.open);
	return (
		<div aria-label={label} className="rounded bg-[var(--omp-code-bg)] text-omp-sm" role="group">
			<TreeView
				className="max-h-72 overflow-auto"
				expanded={expanded}
				nodes={built.rows}
				onExpandedChange={setExpanded}
			/>
		</div>
	);
}

/** Long reference (`desktop_skills_get`'s guide, a snapshot's whole envelope): folded until asked for. */
function Folded({ label, kind, children }: { label: string; kind: string; children: ReactNode }) {
	const bodyId = useId();
	const [open, setOpen] = useState(false);
	return (
		<div className="flex min-w-0 flex-col" data-tool-agent-desktop={kind}>
			<DisclosureButton
				aria-controls={bodyId}
				className="min-h-7 rounded-(--sc-radius-sm) px-1 text-sc-sm text-(--sc-text-muted) hover:text-(--sc-text-secondary)"
				inline
				onToggle={() => setOpen(!open)}
				open={open}
			>
				{label}
			</DisclosureButton>
			<Collapse className="flow-root" open={open}>
				<div id={bodyId} className="mt-1 text-sc-sm">
					{children}
				</div>
			</Collapse>
		</div>
	);
}

function FailedCall({ error }: { error: AgentDesktopError }) {
	const t = useT();
	const outcome = [
		error.delivery && t(`tools.agentDesktop.delivery.${error.delivery}`),
		error.retry && t(`tools.agentDesktop.retry.${error.retry}`),
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="flex min-w-0 flex-col gap-1" data-tool-agent-desktop="error">
			<ToolTextPreview isError text={`${error.code}: ${error.message}`.trimEnd()} />
			{error.suggestion && <div className="text-sc-xs text-(--sc-text-muted)">{error.suggestion}</div>}
			{outcome && <div className="text-sc-xs text-(--sc-text-subtle)">{outcome}</div>}
		</div>
	);
}

/** Data keys the line above already says, or that only name the snapshot a later call refers to. */
const SAID_KEYS: Record<string, true> = { disposition: true, snapshot_id: true };

/**
 * agent-desktop's MCP tools (`mcp__agent_desktop_desktop_*`, direct or through `write xd://`): the call's envelope
 * (`lib/agent-desktop.ts`) as what it holds. A screenshot is the picture; a snapshot, find or list is the element
 * tree; an action is one line (done, and whether the input was delivered); a failure is its code, message and
 * whether it is safe to try again. A result that is no envelope reads as any other MCP tool's.
 */
export function AgentDesktopRenderer(props: ToolRendererProps) {
	const { args, result, isPartial, partialResult, livePreview } = props;
	const t = useT();
	const effective = isPartial && partialResult != null ? partialResult : result;
	const envelope = useMemo(() => parseAgentDesktopResult(effective), [effective]);
	if (effective == null) {
		return isPartial ? (
			<div className="text-omp-sm italic text-[var(--omp-accent)]">{t("tools.agentDesktop.acting")}</div>
		) : null;
	}
	if (!envelope) return <McpRenderer {...props} />;

	const data = envelope.data;
	const images = extractImageDataUrls(effective);
	if (images.length > 0) {
		return (
			<CaptureResult
				livePreview={livePreview}
				icon={<MousePointer2 size={12} className="shrink-0 text-[var(--omp-status-path)]" />}
				action={envelope.command}
				screenshot={images.at(-1)}
				screenshotAlt={t("tools.agentDesktop.captureAlt")}
				imageClass="max-h-64"
				text={envelope.error ? `${envelope.error.code}: ${envelope.error.message}` : ""}
				isError={!envelope.ok}
				pendingLabel={null}
			>
				<span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]">{agentDesktopSummary(args)}</span>
			</CaptureResult>
		);
	}
	const noMatch = (
		<div className="text-sc-xs text-(--sc-text-muted)" data-tool-agent-desktop="no-match">
			{t("tools.agentDesktop.noMatch")}
		</div>
	);
	if (envelope.error) {
		const command = `desktop_${envelope.command.replaceAll("-", "_")}`;
		return isAgentDesktopNoMatch({ command, args }, envelope.error.code) ? (
			noMatch
		) : (
			<FailedCall error={envelope.error} />
		);
	}

	const guide = asString(data?.content);
	if (guide !== undefined)
		return (
			<Folded kind="guide" label={t("tools.agentDesktop.guide")}>
				<MarkdownRenderer content={guide} />
			</Folded>
		);

	const elements = agentDesktopNodes(data);
	if (elements && elements.nodes.length === 0 && elements.omitted === 0) return noMatch;
	if (elements) {
		const app = asString(data?.app);
		const refs = asNumber(data?.ref_count);
		return (
			<div className="flex min-w-0 flex-col gap-1.5" data-tool-agent-desktop="tree">
				{(app || refs !== undefined) && (
					<div className="flex items-center gap-1.5 font-mono text-sc-xs text-(--sc-text-muted)">
						{app && <span className="truncate text-[var(--omp-text)]">{app}</span>}
						{refs !== undefined && <span>{t("tools.agentDesktop.refs", { count: refs })}</span>}
					</div>
				)}
				<ElementTree label={t("tools.agentDesktop.treeLabel")} nodes={elements.nodes} />
				{elements.omitted > 0 && (
					<div className="font-mono text-sc-xs text-(--sc-text-subtle)">
						{t("tools.agentDesktop.moreElements", { count: elements.omitted })}
					</div>
				)}
				{elements.partial && (
					<div className="text-sc-xs text-(--sc-warning)" data-agent-desktop-partial>
						{t("tools.agentDesktop.partial")}
					</div>
				)}
				{/* Everything the envelope said (bounds, actions, native ids), folded: the rows carry what a reader scans. */}
				{data && (
					<Folded kind="raw" label={t("tools.agentDesktop.raw")}>
						<JsonTree label={t("tools.agentDesktop.raw")} openDepth={1} value={data} />
					</Folded>
				)}
			</div>
		);
	}

	const rest = data ? Object.fromEntries(Object.entries(data).filter(([key]) => !SAID_KEYS[key])) : {};
	const delivery = asString(asRecord(data?.disposition)?.delivery);
	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-tool-agent-desktop="action">
			<div className="flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
				<Check aria-hidden className="size-3 shrink-0 text-(--sc-success)" />
				<span>
					{[t("tools.agentDesktop.done"), delivery && t(`tools.agentDesktop.delivery.${delivery}`)]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</div>
			{Object.keys(rest).length > 0 && <JsonTree label={t("tools.generic.result")} openDepth={1} value={rest} />}
		</div>
	);
}
