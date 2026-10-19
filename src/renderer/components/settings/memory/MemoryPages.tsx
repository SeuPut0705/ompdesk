/**
 * Memory › Pages: the project's pages by kind (rules, decisions, gotchas, procedures, sessions, notes), a reader for
 * the chosen one (markdown), and what you can do with it: edit (saved through the server's write path as a new
 * version), pin, rate, delete and, from the Deleted group, restore. Master-detail: on a phone the list, then the page.
 */
import { ChevronDown, ChevronRight, Pin, PinOff, RotateCcw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	AI_MEMORY_KINDS,
	type AiMemoryPage,
	type AiMemoryPageRef,
	type AiMemoryProjectRef,
} from "../../../../shared/ai-memory";
import { formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { type MemoryPageTarget, useMemoryPageStore } from "../../../stores/memory-page";
import {
	Badge,
	Button,
	ConfirmDialog,
	MasterDetail,
	SearchField,
	SettingInfo,
	SkeletonRows,
	TextArea,
} from "../../common";
import { LIST_ROW, MemoryFrame, MutedLine, ReadError, useMemoryAction } from "./memory-ui";
import { projectKey, useMemoryRead } from "./use-memory-read";

const OTHER = "other";
type Group = (typeof AI_MEMORY_KINDS)[number] | typeof OTHER;

function groupOf(page: AiMemoryPageRef): Group {
	return (AI_MEMORY_KINDS as readonly string[]).includes(page.kind ?? "") ? (page.kind as Group) : OTHER;
}

const sameProject = (a: AiMemoryProjectRef, b: AiMemoryProjectRef) =>
	a.workspace === b.workspace && a.project === b.project;

export function MemoryPages({ project }: { project: AiMemoryProjectRef }) {
	const t = useT();
	const pages = useMemoryRead<AiMemoryPageRef[]>(`pages/${projectKey(project)}`, () =>
		window.omp.aiMemory.pages(project),
	);
	const deleted = useMemoryPageStore(s => s.deleted).filter(item => sameProject(item, project));
	const pending = useMemoryPageStore(s => s.pending);
	const [open, setOpen] = useState<MemoryPageTarget | null>(null);
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(["session"]));
	const { busy, run } = useMemoryAction();

	useEffect(() => {
		if (!pending) return;
		const next = useMemoryPageStore.getState().takePending();
		if (next) setOpen(next);
	}, [pending]);
	useEffect(() => {
		setOpen(current => (current && sameProject(current, project) ? current : null));
	}, [project]);

	const groups = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const rows = (pages.data ?? []).filter(
			page => !needle || `${page.title}\n${page.path}`.toLowerCase().includes(needle),
		);
		const out = new Map<Group, AiMemoryPageRef[]>();
		for (const group of [...AI_MEMORY_KINDS, OTHER] as Group[]) out.set(group, []);
		for (const page of rows) out.get(groupOf(page))?.push(page);
		return [...out].filter(([, list]) => list.length > 0);
	}, [pages.data, filter]);

	const toggle = (group: string) =>
		setCollapsed(current => {
			const next = new Set(current);
			if (!next.delete(group)) next.add(group);
			return next;
		});

	const list = (
		<div className="flex min-h-0 flex-col gap-1" data-memory-pages-list>
			<SearchField
				label={t("memory.pages.filter")}
				onValueChange={setFilter}
				placeholder={t("memory.pages.filter")}
				value={filter}
			/>
			<ReadError error={pages.error} onRetry={pages.refresh} />
			{pages.data === undefined && !pages.error && (
				<SkeletonRows label={t("common.loading")} widths={[70, 55, 62]} />
			)}
			{pages.data && groups.length === 0 && deleted.length === 0 && (
				<MutedLine data-memory-empty>{t("memory.pages.empty")}</MutedLine>
			)}
			{groups.map(([group, list]) => {
				const folded = collapsed.has(group) && !filter.trim();
				return (
					<section data-memory-group={group} key={group}>
						<button
							aria-expanded={!folded}
							className="flex min-h-10 w-full items-center gap-1 px-1 text-sc-xs [html[data-input=touch]_&]:min-h-11 font-semibold text-(--sc-text-muted) uppercase"
							data-memory-group-toggle={group}
							onClick={() => toggle(group)}
							type="button"
						>
							{folded ? (
								<ChevronRight className="size-(--sc-icon-sm)" />
							) : (
								<ChevronDown className="size-(--sc-icon-sm)" />
							)}
							{t(`memory.pages.group.${group}`)}
							<span className="font-normal tabular-nums">{list.length}</span>
						</button>
						{!folded &&
							list.map(page => (
								<button
									aria-pressed={open?.path === page.path}
									className={LIST_ROW}
									data-memory-page={page.path}
									key={page.path}
									onClick={() => setOpen({ ...project, path: page.path })}
									title={page.path}
									type="button"
								>
									<span className="min-w-0 flex-1 truncate">{page.title || page.path}</span>
									{page.tier && <Badge variant="muted">{t(`memory.tier.${page.tier}`)}</Badge>}
									<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
										{formatTimeAgo(page.updatedAt)}
									</span>
								</button>
							))}
					</section>
				);
			})}
			{deleted.length > 0 && (
				<section data-memory-group="deleted">
					<h4 className="flex items-center gap-1 px-1 pt-2 pb-1 text-sc-xs font-semibold text-(--sc-text-muted) uppercase">
						{t("memory.pages.deleted")}
						<SettingInfo text={t("memory.pages.deleted.info")} />
					</h4>
					{deleted.map(item => (
						<div
							className="flex items-center gap-2 px-2 py-1 text-sc-sm"
							data-memory-deleted={item.path}
							key={item.path}
						>
							<span className="min-w-0 flex-1 truncate" title={item.path}>
								{item.title}
							</span>
							<Button
								icon={<RotateCcw />}
								loading={busy === `restore:${item.path}`}
								onClick={() =>
									void run(
										`restore:${item.path}`,
										async () => {
											await window.omp.aiMemory.restorePage(item, item.rev);
											useMemoryPageStore.getState().removeDeleted(item);
										},
										t("memory.pages.restored"),
									)
								}
								size="sm"
								variant="secondary"
							>
								{t("memory.pages.restore")}
							</Button>
						</div>
					))}
				</section>
			)}
		</div>
	);

	return (
		<MemoryFrame>
			<MasterDetail
				backLabel={t("memory.pages.back")}
				detail={
					open ? (
						<PageReader key={`${open.path}`} onClose={() => setOpen(null)} target={open} />
					) : (
						<MutedLine data-memory-pick>{t("memory.pages.pick")}</MutedLine>
					)
				}
				label={t("memory.tab.pages")}
				list={list}
				onBack={() => setOpen(null)}
				open={open !== null}
			/>
		</MemoryFrame>
	);
}

function PageReader({ target, onClose }: { target: MemoryPageTarget; onClose: () => void }) {
	const t = useT();
	const key = `page/${projectKey(target)}/${target.path}`;
	const read = useMemoryRead<AiMemoryPage>(key, () => window.omp.aiMemory.readPage(target));
	const page = read.data;
	const { busy, run } = useMemoryAction();
	const [draft, setDraft] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const session = page?.kind === "session";

	if (!page) {
		return (
			<div className="p-3" data-memory-reader>
				<ReadError error={read.error} onRetry={read.refresh} />
				{!read.error && <SkeletonRows label={t("common.loading")} widths={[50, 90, 80, 70]} />}
			</div>
		);
	}

	const write = (body: string, pinned: boolean) =>
		window.omp.aiMemory.writePage({
			workspace: target.workspace,
			project: target.project,
			path: target.path,
			body,
			title: page.title,
			kind: page.kind,
			tier: page.tier ?? undefined,
			tags: page.tags,
			pinned,
		});
	const rate = (signal: "helpful" | "not_helpful") =>
		void run(signal, () => window.omp.aiMemory.feedback(target, signal), t(`memory.pages.rated.${signal}`));

	return (
		<article className="flex min-w-0 flex-col gap-2 p-3" data-memory-reader>
			<header className="flex min-w-0 flex-col gap-0.5">
				{!page.markdown.trimStart().startsWith(`# ${page.title}`) && (
					<h3 className="truncate text-sc-md font-semibold text-(--sc-text)">{page.title}</h3>
				)}
				<p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sc-xs text-(--sc-text-muted)">
					<span className="truncate" title={page.path}>
						{page.path}
					</span>
					{page.kind && <span>{t(`memory.kind.${page.kind}`)}</span>}
					{page.tier && <span>{t(`memory.tier.${page.tier}`)}</span>}
					<span>{formatTimeAgo(page.updatedAt)}</span>
					{page.pinned && <Badge variant="accent">{t("memory.pages.pinned")}</Badge>}
				</p>
			</header>
			<div className="flex flex-wrap items-center gap-x-1 gap-y-4 pb-2" data-memory-actions>
				{draft === null ? (
					<>
						<Button
							data-memory-edit
							disabled={session}
							onClick={() => setDraft(page.markdown)}
							size="sm"
							variant="secondary"
						>
							{t("memory.pages.edit")}
						</Button>
						<Button
							data-memory-pin
							disabled={session}
							icon={page.pinned ? <PinOff /> : <Pin />}
							loading={busy === "pin"}
							onClick={() => void run("pin", () => write(page.markdown, !page.pinned))}
							size="sm"
							variant="secondary"
						>
							{t(page.pinned ? "memory.pages.unpin" : "memory.pages.pin")}
						</Button>
						{session && <SettingInfo text={t("memory.pages.sessionReadOnly")} />}
						<Button
							data-memory-helpful
							icon={<ThumbsUp />}
							loading={busy === "helpful"}
							onClick={() => rate("helpful")}
							size="sm"
							variant="ghost"
						>
							{t("memory.pages.helpful")}
						</Button>
						<Button
							data-memory-not-helpful
							icon={<ThumbsDown />}
							loading={busy === "not_helpful"}
							onClick={() => rate("not_helpful")}
							size="sm"
							variant="ghost"
						>
							{t("memory.pages.notHelpful")}
						</Button>
						<Button
							data-memory-delete
							icon={<Trash2 />}
							onClick={() => setConfirmDelete(true)}
							size="sm"
							variant="secondary"
						>
							{t("common.delete")}
						</Button>
					</>
				) : (
					<>
						<Button
							data-memory-save
							loading={busy === "save"}
							onClick={() =>
								void run(
									"save",
									() => write(draft, page.pinned).then(() => true),
									t("memory.pages.saved"),
								).then(ok => {
									if (!ok) return;
									setDraft(null);
									read.refresh();
								})
							}
							size="sm"
							variant="primary"
						>
							{t("common.save")}
						</Button>
						<Button onClick={() => setDraft(null)} size="sm" variant="secondary">
							{t("common.cancel")}
						</Button>
						<SettingInfo text={t("memory.pages.edit.info")} />
					</>
				)}
			</div>
			{draft === null ? (
				<div className="min-w-0 text-sc-md" data-memory-body>
					<MarkdownRenderer content={page.markdown} />
				</div>
			) : (
				<TextArea
					aria-label={t("memory.pages.editor")}
					autoGrow
					data-memory-editor
					mono
					onChange={event => setDraft(event.target.value)}
					rows={12}
					value={draft}
				/>
			)}
			<ConfirmDialog
				busy={busy === "delete"}
				confirmLabel={t("common.delete")}
				message={t("memory.pages.delete.message", { title: page.title })}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() =>
					void run(
						"delete",
						async () => {
							const result = await window.omp.aiMemory.deletePage({ ...target, title: page.title });
							useMemoryPageStore.getState().addDeleted(result);
							return true;
						},
						t("memory.pages.deletedToast"),
					).then(ok => {
						setConfirmDelete(false);
						if (ok) onClose();
					})
				}
				open={confirmDelete}
				title={t("memory.pages.delete.title")}
				warning={t("memory.pages.delete.warning")}
			/>
		</article>
	);
}
