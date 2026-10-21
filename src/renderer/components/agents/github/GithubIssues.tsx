import { CircleDot, CircleOff, ExternalLink, MessageSquare, Pencil, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { GithubIssueDetail, GithubIssueState } from "../../../../shared/github";
import { formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import {
	AsyncSection,
	Badge,
	Button,
	IconButton,
	Input,
	MasterDetail,
	Modal,
	SearchField,
	Tabs,
	TextArea,
} from "../../common";
import { type GithubSectionProps, GithubToolbar, ListButton, NeedsRepo, useGithubMutation } from "./shared";

const STATES: GithubIssueState[] = ["open", "closed", "all"];

/** Title + body editor for a new or edited issue. */
function IssueEditor({
	open,
	initial,
	heading,
	submitLabel,
	onClose,
	onSubmit,
}: {
	open: boolean;
	initial: { title: string; body: string };
	heading: string;
	submitLabel: string;
	onClose: () => void;
	onSubmit: (value: { title: string; body: string }) => Promise<boolean>;
}) {
	const t = useT();
	const [title, setTitle] = useState(initial.title);
	const [body, setBody] = useState(initial.body);
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim()) return;
		setBusy(true);
		const done = await onSubmit({ title: title.trim(), body });
		setBusy(false);
		if (done) onClose();
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!title.trim()}
						form="github-issue-editor"
						loading={busy}
						type="submit"
						variant="primary"
					>
						{submitLabel}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="lg"
			title={heading}
		>
			<form className="flex flex-col gap-3" id="github-issue-editor" onSubmit={event => void submit(event)}>
				<Input
					autoFocus
					label={t("github.issues.title")}
					onChange={event => setTitle(event.target.value)}
					value={title}
				/>
				<TextArea
					autoGrow
					label={t("github.issues.body")}
					onChange={event => setBody(event.target.value)}
					rows={8}
					value={body}
				/>
			</form>
		</Modal>
	);
}

function IssueDetail({
	issue,
	target,
	onChanged,
}: {
	issue: GithubIssueDetail;
	target: GithubSectionProps["target"];
	onChanged: () => void;
}) {
	const t = useT();
	const { busy, run } = useGithubMutation();
	const [editing, setEditing] = useState(false);
	const [comment, setComment] = useState("");
	const closed = issue.state === "CLOSED";
	return (
		<article className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10" data-github-issue={issue.number}>
			<header className="flex flex-col gap-2">
				<h3 className="text-sc-lg font-semibold text-(--sc-text)">
					{issue.title} <span className="font-normal text-(--sc-text-muted)">#{issue.number}</span>
				</h3>
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<Badge variant={closed ? "muted" : "success"}>
						{t(closed ? "github.issues.closed" : "github.issues.open")}
					</Badge>
					<span>{issue.author}</span>
					<span>{formatTimeAgo(issue.updatedAt)}</span>
					{issue.labels.map(label => (
						<Badge key={label}>{label}</Badge>
					))}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button icon={<Pencil />} onClick={() => setEditing(true)} size="sm" variant="secondary">
						{t("common.edit")}
					</Button>
					<Button
						icon={closed ? <CircleDot /> : <CircleOff />}
						loading={busy === "state"}
						onClick={() =>
							void run(
								"state",
								() =>
									github({
										...target,
										op: "issue_state",
										number: issue.number,
										state: closed ? "open" : "closed",
									}),
								t("github.actionFailed"),
							).then(done => done && onChanged())
						}
						size="sm"
						variant="secondary"
					>
						{t(closed ? "github.issues.reopen" : "github.issues.close")}
					</Button>
					<Button icon={<ExternalLink />} onClick={() => openExternal(issue.url)} size="sm" variant="ghost">
						{t("github.openOnGithub")}
					</Button>
				</div>
			</header>
			<div className="text-sc-md">
				{issue.body.trim() ? (
					<MarkdownRenderer content={issue.body} />
				) : (
					<p className="text-(--sc-text-muted)">{t("github.issues.noBody")}</p>
				)}
			</div>
			<section
				aria-label={t("github.issues.comments")}
				className="flex flex-col gap-3 border-t border-(--sc-divider) pt-4"
			>
				{issue.comments.map((entry, index) => (
					<div
						className="rounded-(--sc-radius-md) border border-(--sc-border) px-3 py-2"
						// Comments only append; a position names one comment while this issue shows.
						key={`${index}:${entry.createdAt}`}
					>
						<div className="mb-1 text-sc-xs text-(--sc-text-muted)">
							{entry.author} · {formatTimeAgo(entry.createdAt)}
						</div>
						<MarkdownRenderer content={entry.body} />
					</div>
				))}
				<form
					className="flex flex-col gap-2"
					onSubmit={event => {
						event.preventDefault();
						const body = comment.trim();
						if (!body) return;
						void run(
							"comment",
							() => github({ ...target, op: "issue_comment", number: issue.number, body }),
							t("github.actionFailed"),
						).then(done => {
							if (!done) return;
							setComment("");
							onChanged();
						});
					}}
				>
					<TextArea
						autoGrow
						label={t("github.issues.addComment")}
						onChange={event => setComment(event.target.value)}
						rows={3}
						value={comment}
					/>
					<div>
						<Button
							disabled={!comment.trim()}
							loading={busy === "comment"}
							size="sm"
							type="submit"
							variant="secondary"
						>
							{t("github.issues.comment")}
						</Button>
					</div>
				</form>
			</section>
			{editing && (
				<IssueEditor
					heading={t("github.issues.editTitle", { number: issue.number })}
					initial={{ title: issue.title, body: issue.body }}
					onClose={() => setEditing(false)}
					onSubmit={value =>
						run(
							"edit",
							() => github({ ...target, op: "issue_edit", number: issue.number, ...value }),
							t("github.actionFailed"),
						).then(done => {
							if (done) onChanged();
							return done;
						})
					}
					open
					submitLabel={t("common.save")}
				/>
			)}
		</article>
	);
}

export function GithubIssues({ target, repoName, targetKey }: GithubSectionProps) {
	const t = useT();
	const [state, setState] = useState<GithubIssueState>("open");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<number | null>(null);
	const [creating, setCreating] = useState(false);
	const { run } = useGithubMutation();
	const list = useGithubLoad(
		repoName ? { ...target, op: "issue_list", state, search: search || undefined } : null,
		`${targetKey}|${state}|${search}`,
	);
	const detail = useGithubLoad(
		repoName && selected !== null ? { ...target, op: "issue_get", number: selected } : null,
		`${targetKey}|${selected}`,
	);
	if (!repoName) return <NeedsRepo />;
	const changed = () => {
		list.reload();
		detail.reload();
	};
	const rows = list.data ?? [];
	return (
		<>
			<GithubToolbar>
				<Tabs
					activeId={state}
					ariaLabel={t("github.issues.stateFilter")}
					onChange={id => setState(id as GithubIssueState)}
					tabs={STATES.map(id => ({ id, label: t(`github.issues.state.${id}`) }))}
					variant="segmented"
				/>
				<form
					className="min-w-48 flex-1"
					onSubmit={event => {
						event.preventDefault();
						setSearch(query.trim());
					}}
				>
					<SearchField label={t("github.issues.search")} onValueChange={setQuery} value={query} />
				</form>
				<IconButton icon={<RefreshCw />} label={t("common.refresh")} loading={list.loading} onClick={list.reload} />
				<Button icon={<Plus />} onClick={() => setCreating(true)} size="sm" variant="secondary">
					{t("github.issues.new")}
				</Button>
			</GithubToolbar>
			<MasterDetail
				detail={
					selected === null ? null : (
						<AsyncSection
							error={detail.error}
							hasData={detail.data !== null}
							loading={detail.loading && !detail.data}
							onRetry={detail.reload}
						>
							{detail.data && <IssueDetail issue={detail.data} onChanged={changed} target={target} />}
						</AsyncSection>
					)
				}
				label={t("github.issues.list")}
				list={
					<AsyncSection
						emptyLabel={t("github.issues.empty")}
						empty={rows.length === 0}
						error={list.error}
						hasData={rows.length > 0}
						loading={list.loading && !list.data}
						onRetry={list.reload}
					>
						<ul className="flex flex-col gap-0.5">
							{rows.map(item => (
								<ListButton
									active={item.number === selected}
									key={item.number}
									onSelect={() => setSelected(item.number)}
								>
									<span className="flex w-full items-center gap-2">
										<CircleDot
											aria-hidden
											className={`size-(--sc-icon-sm) shrink-0 ${item.state === "OPEN" ? "text-(--sc-success)" : "text-(--sc-text-subtle)"}`}
										/>
										<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">{item.title}</span>
									</span>
									<span className="flex w-full items-center gap-2 pl-6 text-sc-xs text-(--sc-text-muted)">
										<span className="shrink-0 tabular-nums">#{item.number}</span>
										<span className="min-w-0 flex-1 truncate">{item.author}</span>
										{item.commentCount > 0 && (
											<span
												className="flex shrink-0 items-center gap-0.5 tabular-nums"
												title={t("github.issues.commentCount", { count: item.commentCount })}
											>
												<MessageSquare aria-hidden className="size-3" />
												{item.commentCount}
											</span>
										)}
										<span className="shrink-0">{formatTimeAgo(item.updatedAt)}</span>
									</span>
								</ListButton>
							))}
						</ul>
					</AsyncSection>
				}
				onBack={() => setSelected(null)}
				open={selected !== null}
			/>
			{creating && (
				<IssueEditor
					heading={t("github.issues.newTitle", { repo: repoName })}
					initial={{ title: "", body: "" }}
					onClose={() => setCreating(false)}
					onSubmit={value =>
						run(
							"create",
							async () => {
								const created = await github({ ...target, op: "issue_create", ...value });
								if (created.number) setSelected(created.number);
							},
							t("github.actionFailed"),
							t("github.issues.created"),
						).then(done => {
							if (done) list.reload();
							return done;
						})
					}
					open
					submitLabel={t("github.issues.create")}
				/>
			)}
		</>
	);
}
