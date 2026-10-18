/**
 * Side panel › Memory: a read-only view of ai-memory (src/shared/ai-memory.ts) through `window.omp.aiMemory`: its
 * status, a project filter, search, the recent pages and the handoffs for the next session. A page opens in the
 * panel as markdown. Nothing here writes; the switch, the console and the data live in Settings › Memory.
 */

import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type {
	AiMemoryHandoff,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProject,
	AiMemoryProjectRef,
} from "../../../shared/ai-memory";
import { aiMemoryStatusText } from "../../lib/ai-memory-text";
import { formatBytes, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { toastError } from "../../stores/toast";
import { Button, EmptyState, IconButton, InlineNotice, SearchField, Select, Spinner } from "../common";
import { PanelActions, PanelListRow } from "./PanelChrome";

const ALL = "";

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** One read through `window.omp.aiMemory`, again whenever `key` changes or `reload` is called; `null` reads nothing. */
function useLoaded<T>(read: (() => Promise<T>) | null, key: string): [Loaded<T>, () => void] {
	const [state, setState] = useState<Loaded<T>>({ status: "loading" });
	const [version, setVersion] = useState(0);
	const latest = useRef(read);
	latest.current = read;
	const enabled = read !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `read` captured; `version` re-reads.
	useEffect(() => {
		const current = latest.current;
		if (!current) return;
		let live = true;
		setState({ status: "loading" });
		current().then(
			data => live && setState({ status: "ready", data }),
			error =>
				live && setState({ status: "error", message: error instanceof Error ? error.message : String(error) }),
		);
		return () => {
			live = false;
		};
	}, [key, version, enabled]);
	return [state, () => setVersion(value => value + 1)];
}

function projectKey(project: AiMemoryProjectRef): string {
	return `${project.workspace}\n${project.project}`;
}

function projectLabel(project: AiMemoryProjectRef): string {
	return project.workspace === project.project ? project.project : `${project.workspace} / ${project.project}`;
}

function Section({ title, children, ...rest }: ComponentProps<"section"> & { title: string }) {
	return (
		<section className="flex flex-col gap-1.5" {...rest}>
			<h3 className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">{title}</h3>
			{children}
		</section>
	);
}

/** Loading, error and empty states shared by every list. */
function ListState<T>({
	loaded,
	empty,
	onRetry,
	children,
}: {
	loaded: Loaded<T[]>;
	empty: string;
	onRetry: () => void;
	children: (items: T[]) => ReactNode;
}) {
	const t = useT();
	if (loaded.status === "loading") return <Spinner label={t("common.loading")} size="sm" />;
	if (loaded.status === "error")
		return (
			<InlineNotice
				action={
					<Button icon={<RefreshCw />} onClick={onRetry} size="sm" variant="ghost">
						{t("common.retry")}
					</Button>
				}
				detail={loaded.message}
				title={t("aiMemoryPanel.loadFailed")}
				tone="danger"
			/>
		);
	if (loaded.data.length === 0) return <p className="text-sc-sm text-(--sc-text-muted)">{empty}</p>;
	return <>{children(loaded.data)}</>;
}

function PageRow({ page, onOpen, showSnippet }: { page: AiMemoryPageRef; onOpen: () => void; showSnippet: boolean }) {
	return (
		<PanelListRow className="flex-col items-start gap-0.5" data-ai-memory-page={page.path} onClick={onOpen}>
			<span className="w-full truncate font-medium">{page.title || page.path}</span>
			{showSnippet && page.snippet && (
				<span className="line-clamp-2 w-full text-sc-xs text-(--sc-text-secondary)">{page.snippet}</span>
			)}
			<span className="w-full truncate text-sc-xs text-(--sc-text-muted)">
				{projectLabel(page)}
				{page.updatedAt ? ` · ${formatTimeAgo(page.updatedAt)}` : ""}
			</span>
		</PanelListRow>
	);
}

function PageView({ page, onBack }: { page: AiMemoryPageRef; onBack: () => void }) {
	const t = useT();
	const [loaded, reload] = useLoaded<AiMemoryPage>(
		() => window.omp.aiMemory.readPage({ workspace: page.workspace, project: page.project, path: page.path }),
		projectKey(page) + page.path,
	);
	return (
		<div className="flex flex-col gap-3" data-ai-memory-page-view>
			<div className="flex items-center gap-2">
				<IconButton icon={<ArrowLeft />} label={t("aiMemoryPanel.back")} onClick={onBack} size="sm" />
				<div className="min-w-0">
					<p className="truncate text-sc-sm font-medium text-(--sc-text)">{page.title || page.path}</p>
					<p className="truncate text-sc-xs text-(--sc-text-muted)">
						{projectLabel(page)} · {page.path}
					</p>
				</div>
			</div>
			{loaded.status === "loading" && <Spinner label={t("common.loading")} size="sm" />}
			{loaded.status === "error" && (
				<InlineNotice
					action={
						<Button icon={<RefreshCw />} onClick={reload} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					detail={loaded.message}
					title={t("aiMemoryPanel.pageFailed")}
					tone="danger"
				/>
			)}
			{loaded.status === "ready" && (
				<div className="text-sc-md text-(--sc-text-secondary)" data-ai-memory-page-text>
					<MarkdownRenderer content={loaded.data.markdown} />
				</div>
			)}
		</div>
	);
}

function HandoffRow({ handoff }: { handoff: AiMemoryHandoff }) {
	const t = useT();
	const open = handoff.state === "open";
	return (
		<div className="flex flex-col gap-0.5 rounded-(--sc-radius-sm) px-2 py-1.5" data-ai-memory-handoff={handoff.id}>
			<p className="truncate text-sc-xs text-(--sc-text-muted)">
				{t("aiMemoryPanel.handoffFrom", { agent: handoff.agent })} · {projectLabel(handoff)}
				{handoff.createdAt ? ` · ${formatTimeAgo(handoff.createdAt)}` : ""}
				{!open && ` · ${handoff.state}`}
			</p>
			<p className="line-clamp-4 text-sc-sm whitespace-pre-wrap text-(--sc-text)">{handoff.summary}</p>
		</div>
	);
}

/** The lists, shown while the server answers. */
function Browser() {
	const t = useT();
	const [projectsLoaded, reloadProjects] = useLoaded<AiMemoryProject[]>(window.omp.aiMemory.projects, "projects");
	const [selected, setSelected] = useState(ALL);
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [open, setOpen] = useState<AiMemoryPageRef | null>(null);
	const projects = projectsLoaded.status === "ready" ? projectsLoaded.data : [];
	const project = projects.find(entry => projectKey(entry) === selected);
	const ref = project ? { workspace: project.workspace, project: project.project } : undefined;
	const scope = selected;

	const [found, reloadFound] = useLoaded<AiMemoryPageRef[]>(
		submitted ? () => window.omp.aiMemory.search(submitted, ref) : null,
		`${submitted}\n${scope}`,
	);
	const [recent, reloadRecent] = useLoaded<AiMemoryPageRef[]>(() => window.omp.aiMemory.recent(ref), scope);
	const [handoffs, reloadHandoffs] = useLoaded<AiMemoryHandoff[]>(() => window.omp.aiMemory.handoffs(ref), scope);

	const refresh = () => {
		reloadProjects();
		if (submitted) reloadFound();
		reloadRecent();
		reloadHandoffs();
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		setSubmitted(query.trim());
	};
	const sortedHandoffs: Loaded<AiMemoryHandoff[]> =
		handoffs.status === "ready"
			? {
					status: "ready",
					data: [...handoffs.data].sort((a, b) => Number(b.state === "open") - Number(a.state === "open")),
				}
			: handoffs;

	if (open) return <PageView onBack={() => setOpen(null)} page={open} />;
	return (
		<div className="flex flex-col gap-5">
			<PanelActions>
				<IconButton icon={<RefreshCw />} label={t("common.refresh")} onClick={refresh} size="sm" />
			</PanelActions>
			<div className="flex flex-col gap-2">
				<Select
					aria-label={t("aiMemoryPanel.project")}
					controlSize="sm"
					onChange={event => setSelected(event.target.value)}
					options={[
						{ value: ALL, label: t("aiMemoryPanel.allProjects") },
						...projects.map(entry => ({ value: projectKey(entry), label: projectLabel(entry) })),
					]}
					value={selected}
				/>
				{projectsLoaded.status === "error" && (
					<p className="text-sc-xs text-(--sc-text-muted)">{t("aiMemoryPanel.projectsFailed")}</p>
				)}
				<form data-ai-memory-search onSubmit={onSubmit}>
					<SearchField
						label={t("aiMemoryPanel.search")}
						onValueChange={value => {
							setQuery(value);
							if (value.trim() === "") setSubmitted("");
						}}
						placeholder={t("aiMemoryPanel.searchPlaceholder")}
						value={query}
					/>
				</form>
			</div>
			{submitted && (
				<Section data-ai-memory-results title={t("aiMemoryPanel.results")}>
					<ListState empty={t("aiMemoryPanel.noResults")} loaded={found} onRetry={reloadFound}>
						{items => (
							<div className="flex flex-col">
								{items.map(page => (
									<PageRow
										key={projectKey(page) + page.path}
										onOpen={() => setOpen(page)}
										page={page}
										showSnippet
									/>
								))}
							</div>
						)}
					</ListState>
				</Section>
			)}
			<Section data-ai-memory-recent title={t("aiMemoryPanel.recent")}>
				<ListState empty={t("aiMemoryPanel.noRecent")} loaded={recent} onRetry={reloadRecent}>
					{items => (
						<div className="flex flex-col">
							{items.map(page => (
								<PageRow
									key={projectKey(page) + page.path}
									onOpen={() => setOpen(page)}
									page={page}
									showSnippet={false}
								/>
							))}
						</div>
					)}
				</ListState>
			</Section>
			<Section data-ai-memory-handoffs title={t("aiMemoryPanel.handoffs")}>
				<ListState empty={t("aiMemoryPanel.noHandoffs")} loaded={sortedHandoffs} onRetry={reloadHandoffs}>
					{items => (
						<div className="flex flex-col gap-1">
							{items.map(handoff => (
								<HandoffRow handoff={handoff} key={`${projectKey(handoff)}${handoff.id}`} />
							))}
						</div>
					)}
				</ListState>
			</Section>
		</div>
	);
}

export function AiMemoryPanel() {
	const t = useT();
	const state = useAiMemoryStore(s => s.state);
	const load = useAiMemoryStore(s => s.load);
	useEffect(() => {
		void load();
	}, [load]);

	const openConsole = () =>
		window.omp.aiMemory.openWeb().catch(error => toastError({ title: t("aiMemory.actionFailed"), error }));

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-ai-memory-panel>
			<div className="flex flex-col gap-1 border-b border-(--sc-divider) px-3 py-2" data-ai-memory-header>
				{state ? (
					<>
						<p className="text-sc-sm font-medium text-(--sc-text)">{aiMemoryStatusText(t, state)}</p>
						{state.stats && (
							<p className="text-sc-xs text-(--sc-text-muted)">
								{t("aiMemory.stats", {
									pages: state.stats.pages,
									sessions: state.stats.sessions,
									observations: state.stats.observations,
									size: formatBytes(state.stats.diskBytes),
								})}
							</p>
						)}
						{state.phase === "ready" && (
							<Button
								className="self-start"
								icon={<ExternalLink />}
								onClick={() => void openConsole()}
								size="sm"
								variant="ghost"
							>
								{t("aiMemory.openConsole")}
							</Button>
						)}
					</>
				) : (
					<Spinner label={t("common.loading")} size="sm" />
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				{state?.phase === "ready" && <Browser />}
				{state && state.phase !== "ready" && <Unavailable detail={state.detail} phase={state.phase} />}
			</div>
		</div>
	);
}

function Unavailable({ phase, detail }: { phase: string; detail: string | null }) {
	const t = useT();
	return (
		<div className="flex flex-col items-start gap-2" data-ai-memory-unavailable={phase}>
			<EmptyState size="sm" title={t(`aiMemoryPanel.unavailable.${phase}`)} />
			{detail && (phase === "failed" || phase === "unreachable") && (
				<p className="text-sc-xs break-words text-(--sc-text-muted)">{detail}</p>
			)}
		</div>
	);
}
