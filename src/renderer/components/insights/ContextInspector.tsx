/**
 * Context inspector (Insights › This session › Inspect): a sheet over the
 * bridge's `context.inspect`. A 20×10 block grid shows the window (each block
 * ≈ window / 200 tokens) coloured by category; the category buttons filter
 * the grid and the entry list under it; each entry (tool, skill, context
 * file, system prompt block, message) opens its text as the provider gets it,
 * capped at 32k characters. xd:// mounted tools show as Deferred with no
 * tokens: only their names are in the prompt until the agent uses one.
 */

import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
	RpcContextCategory,
	RpcContextEntry,
	RpcContextEntryPreview,
	RpcContextInspectResult,
} from "../../../shared/rpc-types";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { Badge, Banner, Button, ErrorDetail, Sheet, Spinner } from "../common";

/** Grid order, as stock's `/context` stacks them: prompt, tools, context, skills, messages. */
export const CONTEXT_CATEGORIES: readonly RpcContextCategory[] = [
	"systemPrompt",
	"builtinTools",
	"mcpTools",
	"extensionTools",
	"systemContext",
	"memoryFiles",
	"skills",
	"messages",
];

/** Category hues — semantic and syntax tokens, so every theme retints them. Free is the bare track. */
export const CATEGORY_COLOR: Record<RpcContextCategory | "free", string> = {
	systemPrompt: "var(--sc-accent)",
	builtinTools: "var(--sc-warning)",
	mcpTools: "var(--omp-syntax-keyword)",
	extensionTools: "var(--omp-syntax-type)",
	systemContext: "var(--omp-syntax-number)",
	memoryFiles: "var(--omp-syntax-string)",
	skills: "var(--sc-success)",
	messages: "var(--sc-info)",
	free: "var(--sc-surface-3)",
};

const GRID_CELLS = 200;
/** Rows rendered before "Show all": a long session holds thousands of messages. */
const LIST_LIMIT = 200;

/**
 * One category per block, in grid order, then free blocks. A category with
 * any tokens gets at least one block; an overfull grid trims the largest
 * categories first so small ones stay visible (stock `planCells`).
 */
export function planBlocks(
	categories: Record<RpcContextCategory, number>,
	perBlock: number,
): Array<RpcContextCategory | "free"> {
	const counts = CONTEXT_CATEGORIES.map(category => {
		const tokens = categories[category];
		return { category, count: tokens > 0 ? Math.max(1, Math.round(tokens / perBlock)) : 0 };
	});
	let overflow = counts.reduce((sum, entry) => sum + entry.count, 0) - GRID_CELLS;
	for (const entry of [...counts].sort((a, b) => b.count - a.count)) {
		while (overflow > 0 && entry.count > 1) {
			entry.count -= 1;
			overflow -= 1;
		}
	}
	const blocks: Array<RpcContextCategory | "free"> = counts.flatMap(entry =>
		Array.from({ length: entry.count }, () => entry.category),
	);
	while (blocks.length < GRID_CELLS) blocks.push("free");
	return blocks.slice(0, GRID_CELLS);
}

const ROLE_KEY: Record<string, string> = {
	user: "contextInspector.role.user",
	assistant: "contextInspector.role.assistant",
	toolResult: "contextInspector.role.toolResult",
};

function EntryPreview({ id }: { id: string }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [preview, setPreview] = useState<RpcContextEntryPreview | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void tabRpc
			.getContextEntry(id)
			.then(response => {
				if (cancelled) return;
				if (response.success) setPreview(response.data as RpcContextEntryPreview);
				else setError(response.error);
			})
			.catch(cause => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [tabRpc.getContextEntry, id]);

	if (error) return <ErrorDetail error={error} />;
	if (!preview) return <Spinner label={t("contextInspector.previewLoading")} size="sm" />;
	return (
		<div className="flex flex-col gap-1">
			<pre className="max-h-80 overflow-auto rounded-(--sc-radius-sm) border border-(--sc-border-subtle) p-2 font-mono text-sc-xs whitespace-pre-wrap break-words text-(--sc-text-secondary)">
				{preview.text || t("contextInspector.previewEmpty")}
			</pre>
			{preview.truncated && (
				<p className="text-sc-xs text-(--sc-text-muted)">
					{t("contextInspector.previewTruncated", {
						shown: preview.text.length.toLocaleString(),
						total: preview.totalChars.toLocaleString(),
					})}
				</p>
			)}
		</div>
	);
}

function EntryRow({ entry, showCategory }: { entry: RpcContextEntry; showCategory: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const role = entry.role ? (ROLE_KEY[entry.role] ? t(ROLE_KEY[entry.role]) : entry.role) : null;
	return (
		<li className="border-b border-(--sc-divider) last:border-b-0">
			<button
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sc-sm hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:outline-(--sc-focus-ring)"
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<ChevronRight
					aria-hidden
					className={cx("size-3.5 shrink-0 text-(--sc-text-muted) transition-transform", open && "rotate-90")}
				/>
				<span
					aria-hidden
					className="size-2 shrink-0 rounded-(--sc-radius-xs)"
					style={{ backgroundColor: CATEGORY_COLOR[entry.category] }}
				/>
				{role && <span className="shrink-0 text-(--sc-text-muted)">{role}</span>}
				<span className="min-w-0 flex-1 truncate font-mono text-(--sc-text)">
					{entry.label || t("contextInspector.untitled")}
				</span>
				{showCategory && (
					<span className="hidden shrink-0 text-sc-xs text-(--sc-text-muted) sm:inline">
						{t(`contextInspector.cat.${entry.category}`)}
					</span>
				)}
				{entry.deferred ? (
					<Badge variant="muted">{t("contextInspector.deferred")}</Badge>
				) : (
					<span className="w-14 shrink-0 text-right tabular-nums text-(--sc-text-secondary)">
						{formatTokens(entry.tokens)}
					</span>
				)}
			</button>
			{open && (
				<div className="px-2 pb-2 pl-7">
					<EntryPreview id={entry.id} />
				</div>
			)}
		</li>
	);
}

function InspectorBody({ data }: { data: RpcContextInspectResult }) {
	const t = useT();
	const [selected, setSelected] = useState<RpcContextCategory | null>(null);
	const [showAll, setShowAll] = useState(false);
	const capacityKnown = data.contextWindow > 0;
	const scale = Math.max(1, capacityKnown ? data.contextWindow : data.usedTokens);
	const perBlock = scale / GRID_CELLS;
	const blocks = planBlocks(data.categories, perBlock);
	const over = capacityKnown && data.usedTokens > data.contextWindow;
	const entries = data.entries
		.filter(entry => selected === null || entry.category === selected)
		.sort((a, b) => b.tokens - a.tokens);
	const shown = showAll ? entries : entries.slice(0, LIST_LIMIT);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sc-sm">
				<span className="min-w-0 truncate font-mono text-(--sc-text-secondary)">
					{data.model || t("contextReport.noModel")}
				</span>
				<span className="shrink-0 font-medium tabular-nums">
					{capacityKnown
						? t("contextReport.usedOf", {
								used: formatTokens(data.usedTokens),
								window: formatTokens(data.contextWindow),
								percent: Math.round((data.usedTokens / data.contextWindow) * 100),
							})
						: t("contextReport.usedWithoutWindow", { used: formatTokens(data.usedTokens) })}
				</span>
			</div>
			{over && (
				<Banner title={t("contextInspector.overWindow")} variant="warning">
					{t("contextInspector.overWindowBody")}
				</Banner>
			)}
			<div className="flex flex-col gap-1.5">
				<div aria-hidden className="grid grid-cols-20 gap-0.5" data-testid="context-grid">
					{blocks.map((category, index) => (
						<span
							className={cx(
								"aspect-square rounded-[2px] transition-opacity",
								selected !== null && category !== selected && "opacity-25",
							)}
							key={index}
							style={{ backgroundColor: CATEGORY_COLOR[category] }}
						/>
					))}
				</div>
				<p className="text-sc-xs text-(--sc-text-muted)">
					{t("contextInspector.perBlock", { tokens: formatTokens(Math.round(perBlock)) })}
					{" · "}
					{data.anchored ? t("contextReport.anchored") : t("contextReport.estimated")}
				</p>
			</div>
			<div aria-label={t("contextInspector.categories")} className="flex flex-wrap gap-1.5" role="group">
				<Button
					aria-pressed={selected === null}
					onClick={() => setSelected(null)}
					size="sm"
					variant={selected === null ? "primary" : "secondary"}
				>
					{t("contextInspector.all")}
				</Button>
				{CONTEXT_CATEGORIES.filter(
					category => data.categories[category] > 0 || data.entries.some(entry => entry.category === category),
				).map(category => (
					<Button
						aria-pressed={selected === category}
						icon={
							<span
								aria-hidden
								className="size-2.5 rounded-(--sc-radius-xs)"
								style={{ backgroundColor: CATEGORY_COLOR[category] }}
							/>
						}
						key={category}
						onClick={() => setSelected(value => (value === category ? null : category))}
						size="sm"
						variant={selected === category ? "primary" : "secondary"}
					>
						{t(`contextInspector.cat.${category}`)}
						<span className="tabular-nums opacity-80">{formatTokens(data.categories[category])}</span>
					</Button>
				))}
			</div>
			<div className="flex flex-col gap-1">
				<p className="text-sc-xs text-(--sc-text-muted)">{t("contextInspector.entriesNote")}</p>
				{entries.length === 0 ? (
					<p className="py-4 text-center text-sc-sm text-(--sc-text-muted)">{t("contextInspector.empty")}</p>
				) : (
					<ul className="rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
						{shown.map(entry => (
							<EntryRow entry={entry} key={entry.id} showCategory={selected === null} />
						))}
					</ul>
				)}
				{shown.length < entries.length && (
					<Button className="self-center" onClick={() => setShowAll(true)} size="sm" variant="ghost">
						{t("contextInspector.showAll", { count: entries.length })}
					</Button>
				)}
			</div>
		</div>
	);
}

export function ContextInspector({ open, onClose }: { open: boolean; onClose: () => void }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [data, setData] = useState<RpcContextInspectResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(() => {
		let cancelled = false;
		setError(null);
		setLoading(true);
		void tabRpc
			.getContextInspect(true)
			.then(response => {
				if (cancelled) return;
				if (response.success) setData(response.data as RpcContextInspectResult);
				else setError(response.error);
			})
			.catch(cause => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [tabRpc.getContextInspect]);

	useEffect(() => {
		if (open) return load();
	}, [open, load]);

	return (
		<Sheet
			description={t("contextInspector.description")}
			onClose={onClose}
			open={open}
			size="lg"
			title={t("contextInspector.title")}
		>
			{error ? (
				<Banner live title={t("contextInspector.error")} variant="warning">
					<ErrorDetail error={error} />
					<Button className="mt-2" onClick={load} size="sm">
						{t("common.retry")}
					</Button>
				</Banner>
			) : data && !loading ? (
				<InspectorBody data={data} />
			) : (
				<div className="flex justify-center py-6">
					<Spinner label={t("contextInspector.loading")} />
				</div>
			)}
		</Sheet>
	);
}
