/**
 * Memory › Sessions: the recent captured sessions with their observation counts. A session opens its raw
 * observations (prompts, tool calls, stops) read-only, 50 a page.
 */
import { useState } from "react";
import type {
	AiMemoryObservation,
	AiMemoryObservations,
	AiMemoryProjectRef,
	AiMemorySession,
} from "../../../../shared/ai-memory";
import { formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Badge, Button, CopyButton, MasterDetail, SettingInfo, SkeletonRows } from "../../common";
import { LIST_ROW, MemoryFrame, MutedLine, ReadError } from "./memory-ui";
import { projectKey, useMemoryRead } from "./use-memory-read";

const PAGE = 50;
const LONG = 400;

const folder = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

export function MemorySessions({ project }: { project: AiMemoryProjectRef }) {
	const t = useT();
	const read = useMemoryRead<AiMemorySession[]>(`sessions/${projectKey(project)}`, () =>
		window.omp.aiMemory.sessions(project),
	);
	const [openId, setOpenId] = useState<string | null>(null);
	const chosen = (read.data ?? []).find(session => session.id === openId) ?? null;

	const list = (
		<div className="flex flex-col gap-0.5" data-memory-sessions-list>
			<p className="flex items-center gap-1 px-1 pb-3 text-sc-xs text-(--sc-text-muted)">
				{t("memory.sessions.title")}
				<SettingInfo text={t("memory.sessions.info")} />
			</p>
			<ReadError error={read.error} onRetry={read.refresh} />
			{read.data === undefined && !read.error && <SkeletonRows label={t("common.loading")} widths={[70, 55]} />}
			{read.data && read.data.length === 0 && <MutedLine data-memory-empty>{t("memory.sessions.empty")}</MutedLine>}
			{(read.data ?? []).map(session => (
				<button
					aria-pressed={session.id === openId}
					className={LIST_ROW}
					data-list-item
					data-memory-session={session.id}
					key={session.id}
					onClick={() => setOpenId(session.id)}
					title={session.cwd}
					type="button"
				>
					<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{formatTimeAgo(session.startedAt)}</span>
					<span className="min-w-0 flex-1 truncate">
						{session.agent} · {folder(session.cwd)}
					</span>
					{!session.endedAt && <Badge variant="info">{t("memory.sessions.open")}</Badge>}
					{session.consolidation &&
						session.consolidation !== "completed" &&
						session.consolidation !== "superseded" && (
							<Badge variant={session.consolidation === "failed" ? "error" : "muted"}>
								{t(`memory.sessions.job.${session.consolidation}`)}
							</Badge>
						)}
					<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">{session.observations}</span>
				</button>
			))}
		</div>
	);

	return (
		<MemoryFrame>
			<MasterDetail
				backLabel={t("memory.tab.sessions")}
				detail={
					chosen ? (
						<Observations key={chosen.id} project={project} session={chosen} />
					) : (
						<MutedLine data-memory-pick>{t("memory.sessions.pick")}</MutedLine>
					)
				}
				label={t("memory.tab.sessions")}
				list={list}
				onBack={() => setOpenId(null)}
				open={chosen !== null}
			/>
		</MemoryFrame>
	);
}

function Observations({ project, session }: { project: AiMemoryProjectRef; session: AiMemorySession }) {
	const t = useT();
	const [offset, setOffset] = useState(0);
	const read = useMemoryRead<AiMemoryObservations>(`observations/${projectKey(project)}/${session.id}/${offset}`, () =>
		window.omp.aiMemory.observations(project, session.id, offset),
	);
	const data = read.data;
	const total = data?.total ?? session.observations;
	return (
		<section className="flex min-w-0 flex-col gap-2 p-3" data-memory-observations={session.id}>
			<header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sc-xs text-(--sc-text-muted)">
				<span className="font-mono">{session.id.slice(0, 8)}</span>
				<CopyButton label={t("memory.sessions.copyId")} text={session.id} />
				<span>{session.agent}</span>
				<span className="min-w-0 truncate" title={session.cwd}>
					{session.cwd}
				</span>
				<span className="tabular-nums">{t("memory.sessions.total", { count: total })}</span>
			</header>
			<ReadError error={read.error} onRetry={read.refresh} />
			{!data && !read.error && <SkeletonRows label={t("common.loading")} widths={[90, 70, 80]} />}
			{data?.observations.map(observation => (
				<ObservationBlock key={observation.id} observation={observation} />
			))}
			{data && total > PAGE && (
				<div className="flex items-center gap-2" data-memory-observations-pager>
					<Button
						disabled={offset === 0}
						onClick={() => setOffset(Math.max(0, offset - PAGE))}
						size="sm"
						variant="secondary"
					>
						{t("memory.sessions.previous")}
					</Button>
					<span className="text-sc-xs tabular-nums text-(--sc-text-muted)">
						{offset + 1}–{Math.min(total, offset + PAGE)} / {total}
					</span>
					<Button
						disabled={offset + PAGE >= total}
						onClick={() => setOffset(offset + PAGE)}
						size="sm"
						variant="secondary"
					>
						{t("memory.sessions.next")}
					</Button>
				</div>
			)}
		</section>
	);
}

function ObservationBlock({ observation }: { observation: AiMemoryObservation }) {
	const t = useT();
	const [more, setMore] = useState(false);
	const long = observation.body.length > LONG;
	const shown = long && !more ? `${observation.body.slice(0, LONG)}…` : observation.body;
	return (
		<div
			className="flex min-w-0 flex-col gap-0.5 border-b border-(--sc-divider) pb-2"
			data-memory-observation={observation.id}
		>
			<p className="flex min-w-0 items-center gap-2 text-sc-xs text-(--sc-text-muted)">
				<Badge variant="muted">{observation.kind}</Badge>
				<span>{formatTimeAgo(observation.createdAt)}</span>
				<span className="min-w-0 truncate text-sc-sm text-(--sc-text)">{observation.title}</span>
			</p>
			{observation.body && (
				<pre className="max-h-48 overflow-auto font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-secondary)">
					{shown}
				</pre>
			)}
			{long && (
				<Button className="self-start" onClick={() => setMore(value => !value)} size="sm" variant="ghost">
					{t(more ? "memory.sessions.less" : "memory.sessions.more")}
				</Button>
			)}
		</div>
	);
}
