/**
 * Side panel › Memory: a glance at Memory (src/shared/ai-memory.ts) through `window.omp.aiMemory`: its status and
 * counts, the recent pages and the open handoffs. Everything else (search, reading, editing, the switch) is the
 * Memory page in Settings; the buttons and every row here open it. The view id stays `memory` so saved
 * default-view prefs keep working.
 */
import { ExternalLink, Settings2 } from "lucide-react";
import { useEffect } from "react";
import type { AiMemoryHandoff, AiMemoryPageRef } from "../../../shared/ai-memory";
import { aiMemoryStatusText } from "../../lib/ai-memory-text";
import { formatBytes, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { useMemoryPageStore } from "../../stores/memory-page";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, SkeletonRows } from "../common";
import { useMemoryRead } from "../settings/memory/use-memory-read";
import { PanelListRow } from "./PanelChrome";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function AiMemoryPanel() {
	const t = useT();
	const state = useAiMemoryStore(s => s.state);
	const load = useAiMemoryStore(s => s.load);
	useEffect(() => {
		void load();
	}, [load]);
	const ready = state?.phase === "ready";
	const recent = useMemoryRead<AiMemoryPageRef[]>(ready ? "recent/all" : null, () => window.omp.aiMemory.recent());
	const handoffs = useMemoryRead<AiMemoryHandoff[]>(ready ? "handoffs/all" : null, () =>
		window.omp.aiMemory.handoffs(),
	);
	const open = (sub?: string) => useUiStore.getState().openSettings(sub ? `memory:${sub}` : "memory");
	const openConsole = () =>
		window.omp.aiMemory.openWeb().catch(error => toastError({ title: t("memory.actionFailed"), error }));
	const openHandoffs = (handoffs.data ?? []).filter(handoff => handoff.state === "open").slice(0, 5);

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-ai-memory-panel>
			<div className="flex flex-col gap-1 border-b border-(--sc-divider) px-3 py-2" data-ai-memory-header>
				{state ? (
					<>
						<p className="text-sc-sm font-medium text-(--sc-text)">{aiMemoryStatusText(t, state)}</p>
						{state.stats && (
							<p className="text-sc-xs text-(--sc-text-muted)">
								{t("memory.overview.counts.value", {
									pages: state.stats.pages,
									sessions: state.stats.sessions,
									observations: state.stats.observations,
								})}
								{` · ${formatBytes(state.stats.diskBytes)}`}
							</p>
						)}
						<div className="flex flex-wrap gap-1">
							<Button data-memory-open icon={<Settings2 />} onClick={() => open()} size="sm" variant="secondary">
								{t("memory.open")}
							</Button>
							{ready && (
								<Button icon={<ExternalLink />} onClick={() => void openConsole()} size="sm" variant="ghost">
									{t("memory.overview.console.open")}
								</Button>
							)}
						</div>
					</>
				) : (
					<SkeletonRows label={t("common.loading")} widths={[60, 40]} />
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				{state && !ready && (
					<div data-ai-memory-unavailable={state.phase}>
						<EmptyState size="sm" title={t(`memory.panel.unavailable.${state.phase}`)} />
						{state.detail && (state.phase === "failed" || state.phase === "unreachable") && (
							<p className="text-sc-xs break-words text-(--sc-text-muted)">{state.detail}</p>
						)}
					</div>
				)}
				{ready && (
					<div className="flex flex-col gap-5">
						<section data-ai-memory-recent>
							<h3 className="mb-1 text-sc-xs font-semibold text-(--sc-text-muted) uppercase">
								{t("memory.panel.recent")}
							</h3>
							{recent.data === undefined ? (
								<SkeletonRows label={t("common.loading")} widths={[70, 55]} />
							) : recent.data.length === 0 ? (
								<p className="text-sc-sm text-(--sc-text-muted)">{t("memory.pages.empty")}</p>
							) : (
								recent.data.slice(0, 8).map(page => (
									<PanelListRow
										className="flex-col items-start gap-0.5"
										data-ai-memory-page={page.path}
										key={`${page.workspace}/${page.project}/${page.path}`}
										onClick={() => {
											useMemoryPageStore.getState().openPage(page);
											open("pages");
										}}
									>
										<span className="w-full truncate font-medium">{page.title || page.path}</span>
										<span className="w-full truncate text-sc-xs text-(--sc-text-muted)">
											{page.project}
											{page.updatedAt ? ` · ${formatTimeAgo(page.updatedAt)}` : ""}
										</span>
									</PanelListRow>
								))
							)}
						</section>
						<section data-ai-memory-handoffs>
							<h3 className="mb-1 text-sc-xs font-semibold text-(--sc-text-muted) uppercase">
								{t("memory.handoffs.title")}
							</h3>
							{openHandoffs.length === 0 ? (
								<p className="text-sc-sm text-(--sc-text-muted)">{t("memory.handoffs.empty")}</p>
							) : (
								openHandoffs.map(handoff => (
									<PanelListRow
										className="flex-col items-start gap-0.5"
										key={`${handoff.workspace}/${handoff.project}/${handoff.id}`}
										onClick={() => {
											useMemoryPageStore
												.getState()
												.setProject({ workspace: handoff.workspace, project: handoff.project });
											open("handoffs");
										}}
									>
										<span className="w-full truncate text-sc-xs text-(--sc-text-muted)">
											{t("memory.handoffs.from", { agent: handoff.agent })} ·{" "}
											{formatTimeAgo(handoff.createdAt)}
										</span>
										<span className="line-clamp-2 w-full text-sc-sm text-(--sc-text-secondary)">
											{oneLine(handoff.summary)}
										</span>
									</PanelListRow>
								))
							)}
						</section>
					</div>
				)}
			</div>
		</div>
	);
}
