/**
 * Settings › Memory: one page for OMPdesk's memory (src/main/ai-memory/, contract src/shared/ai-memory.ts). Tabs:
 * Overview (switch, status, scope, counts, console, privacy), Search, Pages (browse, read, edit, pin, delete,
 * restore, rate), Handoffs, Sessions, Profile and Maintenance. The tab is the Settings sub-target (`memory:pages`),
 * so the palette, the side panel and a search result can land on one. Every section reads through
 * `useMemoryRead` (last known value at the first frame) and writes through `window.omp.aiMemory`.
 */
import { type CSSProperties, useEffect, useMemo } from "react";
import type { AiMemoryProject, AiMemoryProjectRef } from "../../../../shared/ai-memory";
import { useT } from "../../../lib/i18n";
import { useAiMemoryStore } from "../../../stores/ai-memory";
import { MEMORY_PAGE_TABS, type MemoryPageTab, useMemoryPageStore } from "../../../stores/memory-page";
import { useTabsStore } from "../../../stores/tabs";
import { Select, SkeletonRows, Tabs } from "../../common";
import { SettingsSection } from "../SettingsLayout";
import { useSettingsNavigate } from "../settings-navigation";
import { MemoryHandoffs } from "./MemoryHandoffs";
import { MemoryMaintenance } from "./MemoryMaintenance";
import { MemoryOverview } from "./MemoryOverview";
import { MemoryPages } from "./MemoryPages";
import { MemoryProfile } from "./MemoryProfile";
import { MemorySearch } from "./MemorySearch";
import { MemorySessions } from "./MemorySessions";
import { projectKey, useMemoryRead } from "./use-memory-read";

export function projectLabel(project: AiMemoryProjectRef): string {
	return project.workspace === "default" || project.workspace === project.project
		? project.project
		: `${project.workspace} / ${project.project}`;
}

/**
 * The project the page shows: the user's pick, else the one named after the active session's folder
 * (`owner-repo` ends with the folder name), else the most recently updated one.
 */
export function resolveProject(
	projects: readonly AiMemoryProject[],
	picked: AiMemoryProjectRef | null,
	cwd: string,
): AiMemoryProjectRef | null {
	if (picked && projects.some(entry => entry.workspace === picked.workspace && entry.project === picked.project))
		return picked;
	const folder = cwd.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
	const named = folder
		? projects.find(
				entry => entry.project.toLowerCase() === folder || entry.project.toLowerCase().endsWith(`-${folder}`),
			)
		: undefined;
	const chosen = named ?? projects[0];
	return chosen ? { workspace: chosen.workspace, project: chosen.project } : null;
}

export function MemorySection({ sub }: { sub?: string }) {
	const t = useT();
	const navigate = useSettingsNavigate();
	const state = useAiMemoryStore(s => s.state);
	const load = useAiMemoryStore(s => s.load);
	const openRequest = useMemoryPageStore(s => s.openRequest);
	const picked = useMemoryPageStore(s => s.project);
	const setProject = useMemoryPageStore(s => s.setProject);
	const cwd = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.cwd ?? "");
	const tab: MemoryPageTab = (MEMORY_PAGE_TABS as readonly string[]).includes(sub ?? "")
		? (sub as MemoryPageTab)
		: "overview";

	useEffect(() => {
		void load();
	}, [load]);

	// A section asked for a page (a search hit, a profile entry): show Pages.
	useEffect(() => {
		if (openRequest > 0) navigate("memory:pages");
	}, [openRequest, navigate]);

	const ready = state?.enabled === true && state.phase === "ready";
	const projects = useMemoryRead<AiMemoryProject[]>(ready ? "projects" : null, () => window.omp.aiMemory.projects());
	const project = useMemo(() => resolveProject(projects.data ?? [], picked, cwd), [projects.data, picked, cwd]);

	const handoffCount = useOpenHandoffCount(ready ? project : null);

	if (!state) {
		return (
			<SettingsSection id="settings-memory" scope="app">
				<SkeletonRows label={t("common.loading")} widths={[60, 74, 46]} />
			</SettingsSection>
		);
	}

	const usable = state.enabled && state.phase !== "unsupported";
	const open = (id: string) => navigate(`memory:${id}`);
	const tabs = MEMORY_PAGE_TABS.map(id => ({
		id,
		label: t(`memory.tab.${id}`),
		...(id === "handoffs" && handoffCount > 0 ? { badge: handoffCount } : {}),
	}));

	return (
		<SettingsSection id="settings-memory" scope="app">
			{usable && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2" data-memory-bar>
					{/* Seven tabs 4 px apart (Tabs: gap-1): each one's touch reach stops at half that gap (mobile.css). */}
					<div className="w-full min-w-0 sm:w-auto sm:flex-1" style={{ "--hit-gap-x": "4px" } as CSSProperties}>
						<Tabs activeId={tab} ariaLabel={t("memory.title")} onChange={open} tabs={tabs} />
					</div>
					{tab !== "overview" && tab !== "profile" && (projects.data?.length ?? 0) > 0 && project && (
						<Select
							aria-label={t("memory.project")}
							controlSize="sm"
							data-memory-project
							onChange={event => {
								const [workspace, name] = event.target.value.split("/");
								if (workspace && name) setProject({ workspace, project: name });
							}}
							options={(projects.data ?? []).map(entry => ({
								value: projectKey(entry),
								label: projectLabel(entry),
							}))}
							value={projectKey(project)}
						/>
					)}
				</div>
			)}
			<div aria-label={t(`memory.tab.${tab}`)} data-memory-tab={tab} role="tabpanel">
				{tab === "overview" || !usable ? (
					<MemoryOverview project={project} projects={projects.data ?? []} state={state} />
				) : !ready ? (
					<p className="py-3 text-sc-sm text-(--sc-text-muted)" data-memory-unavailable>
						{t(`memory.unavailable.${state.phase === "starting" ? "starting" : "unreachable"}`)}
					</p>
				) : !project ? (
					<p className="py-3 text-sc-sm text-(--sc-text-muted)" data-memory-empty>
						{t("memory.noProjects")}
					</p>
				) : tab === "search" ? (
					<MemorySearch project={project} />
				) : tab === "pages" ? (
					<MemoryPages project={project} />
				) : tab === "handoffs" ? (
					<MemoryHandoffs project={project} />
				) : tab === "sessions" ? (
					<MemorySessions project={project} />
				) : tab === "profile" ? (
					<MemoryProfile />
				) : (
					<MemoryMaintenance project={project} state={state} />
				)}
			</div>
		</SettingsSection>
	);
}

/** Open handoffs of the project, for the tab's badge (the same read the Handoffs tab shows). */
function useOpenHandoffCount(project: AiMemoryProjectRef | null): number {
	const read = useMemoryRead<{ state: string }[]>(project ? `handoffs/${projectKey(project)}` : null, () =>
		project ? window.omp.aiMemory.handoffs(project) : Promise.resolve([]),
	);
	return (read.data ?? []).filter(handoff => handoff.state === "open").length;
}
