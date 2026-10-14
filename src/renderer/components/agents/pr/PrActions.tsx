/**
 * Pull request actions in the PR Center detail: merge with a method
 * (merge commit, squash, rebase) behind a confirmation, edit title, body
 * and base, the conversation (comments, reviews, inline review comments)
 * and a review form (comment, approve, request changes). Everything runs
 * through `gh` in main on the active tab's repository.
 */
import { CheckCircle2, GitMerge, MessageSquare, Pencil, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { RpcCommand, RpcPrComments, RpcPrDetail, RpcPrMergeMethod } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { usePrCenterStore } from "../../../stores/pr-center";
import { toast, toastError } from "../../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	IconButton,
	InlineNotice,
	Input,
	Modal,
	Select,
	Spinner,
	TextArea,
} from "../../common";

const MERGE_METHODS: RpcPrMergeMethod[] = ["merge", "squash", "rebase"];

/** Run one gh-backed PR command; toasts a failure and answers whether it worked. */
async function runPr(command: RpcCommand, failure: string): Promise<boolean> {
	try {
		const response = await window.omp.rpc.command(command);
		if (response.success) return true;
		toastError({ title: failure, error: response });
	} catch (error) {
		toastError({ title: failure, error });
	}
	return false;
}

/** Why GitHub would refuse a merge right now, from `mergeStateStatus`; null when nothing blocks it. */
function mergeBlock(detail: RpcPrDetail): "draft" | "conflicts" | "blocked" | null {
	if (detail.isDraft) return "draft";
	if (detail.mergeStateStatus === "DIRTY") return "conflicts";
	if (detail.mergeStateStatus === "BLOCKED") return "blocked";
	return null;
}

export function PrMergeButton({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const deleteId = useId();
	const [open, setOpen] = useState(false);
	const [method, setMethod] = useState<RpcPrMergeMethod>("merge");
	const [deleteBranch, setDeleteBranch] = useState(true);
	const [busy, setBusy] = useState(false);
	if (detail.state && detail.state !== "OPEN") return null;
	const block = mergeBlock(detail);
	const merge = async () => {
		setBusy(true);
		const merged = await runPr(
			{ type: "pr_merge", number: detail.number, method, deleteBranch },
			t("prCenter.merge.failed"),
		);
		setBusy(false);
		if (!merged) return;
		setOpen(false);
		toast({ variant: "success", message: t("prCenter.merge.done", { number: String(detail.number) }) });
		await usePrCenterStore.getState().reloadSelected();
	};
	return (
		<>
			<Button
				disabled={block === "draft"}
				icon={<GitMerge />}
				onClick={() => setOpen(true)}
				size="sm"
				title={block ? t(`prCenter.merge.block.${block}`) : undefined}
				variant="secondary"
			>
				{t("prCenter.merge.open")}
			</Button>
			<Modal
				footer={
					<>
						<Button autoFocus onClick={() => setOpen(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button loading={busy} onClick={() => void merge()} variant="primary">
							{t(`prCenter.merge.submit.${method}`)}
						</Button>
					</>
				}
				onClose={() => setOpen(false)}
				open={open}
				size="sm"
				title={t("prCenter.merge.title", { number: String(detail.number) })}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sc-sm text-(--sc-text-secondary)">
						{t("prCenter.merge.body", { head: detail.headRefName, base: detail.baseRefName })}
					</p>
					<Select
						label={t("prCenter.merge.method")}
						onChange={event => setMethod(event.target.value as RpcPrMergeMethod)}
						options={MERGE_METHODS.map(value => ({ value, label: t(`prCenter.merge.method.${value}`) }))}
						value={method}
					/>
					<label className="flex items-center gap-2 text-sc-sm text-(--sc-text-secondary)" htmlFor={deleteId}>
						<input
							checked={deleteBranch}
							className="size-4 shrink-0 accent-(--sc-accent)"
							id={deleteId}
							onChange={event => setDeleteBranch(event.target.checked)}
							type="checkbox"
						/>
						{t("prCenter.merge.deleteBranch", { head: detail.headRefName })}
					</label>
					{block && block !== "draft" && (
						<p className="text-sc-sm text-(--sc-warning)">{t(`prCenter.merge.block.${block}`)}</p>
					)}
				</div>
			</Modal>
		</>
	);
}

export function PrEditButton({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const formId = useId();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState(detail.title);
	const [body, setBody] = useState(detail.body);
	const [base, setBase] = useState(detail.baseRefName);
	const [busy, setBusy] = useState(false);
	if (detail.state && detail.state !== "OPEN") return null;
	const start = () => {
		setTitle(detail.title);
		setBody(detail.body);
		setBase(detail.baseRefName);
		setOpen(true);
	};
	const save = async () => {
		if (!title.trim()) return;
		setBusy(true);
		const command: RpcCommand = {
			type: "pr_edit",
			number: detail.number,
			title: title !== detail.title ? title : undefined,
			body: body !== detail.body ? body : undefined,
			base: base.trim() && base.trim() !== detail.baseRefName ? base.trim() : undefined,
		};
		const saved = await runPr(command, t("prCenter.edit.failed"));
		setBusy(false);
		if (!saved) return;
		setOpen(false);
		await usePrCenterStore.getState().reloadSelected();
	};
	return (
		<>
			<Button icon={<Pencil />} onClick={start} size="sm" variant="secondary">
				{t("prCenter.edit.open")}
			</Button>
			<Modal
				footer={
					<>
						<Button onClick={() => setOpen(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button disabled={!title.trim()} form={formId} loading={busy} type="submit" variant="primary">
							{t("common.save")}
						</Button>
					</>
				}
				onClose={() => setOpen(false)}
				open={open}
				size="lg"
				title={t("prCenter.edit.title", { number: String(detail.number) })}
			>
				<form
					className="flex flex-col gap-3"
					id={formId}
					onSubmit={event => {
						event.preventDefault();
						void save();
					}}
				>
					<Input
						label={t("prCenter.titleLabel")}
						onChange={event => setTitle(event.target.value)}
						onInput={event => setTitle(event.currentTarget.value)}
						value={title}
					/>
					<Input
						label={t("prCenter.edit.base")}
						mono
						onChange={event => setBase(event.target.value)}
						onInput={event => setBase(event.currentTarget.value)}
						value={base}
					/>
					<TextArea
						label={t("prCenter.bodyLabel")}
						onChange={event => setBody(event.target.value)}
						onInput={event => setBody(event.currentTarget.value)}
						rows={10}
						value={body}
					/>
				</form>
			</Modal>
		</>
	);
}

const REVIEW_STATE_TONE: Record<string, BadgeVariant> = {
	APPROVED: "success",
	CHANGES_REQUESTED: "error",
};

/** Conversation and review form for the selected PR. */
export function PrConversation({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const [comments, setComments] = useState<RpcPrComments | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const number = detail.number;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await window.omp.rpc.command({ type: "pr_comments", number });
			if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
			setComments(response.data as RpcPrComments);
		} catch (cause) {
			setError(errorDetail(cause));
		} finally {
			setLoading(false);
		}
	}, [number, t]);

	useEffect(() => {
		setComments(null);
		void load();
	}, [load]);

	const submit = async (event: "comment" | "approve" | "request_changes") => {
		setBusy(event);
		const command: RpcCommand =
			event === "comment"
				? { type: "pr_comment", number, body: text }
				: { type: "pr_review", number, event, body: text };
		const done = await runPr(command, t("prCenter.review.failed"));
		setBusy(null);
		if (!done) return;
		setText("");
		toast({ variant: "success", message: t(`prCenter.review.done.${event}`) });
		void load();
		if (event !== "comment") void usePrCenterStore.getState().reloadSelected();
	};

	const open = !detail.state || detail.state === "OPEN";
	return (
		<section aria-label={t("prCenter.section.conversation")} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<h3 className="text-sc-sm font-semibold text-(--sc-text-secondary)">
					{t("prCenter.section.conversation")}
					{comments && ` (${comments.entries.length})`}
				</h3>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={loading}
					onClick={() => void load()}
					size="sm"
				/>
			</div>
			{error && <InlineNotice detail={error} live title={t("prCenter.review.loadFailed")} tone="danger" />}
			{!comments && !error ? (
				<Spinner label={t("prCenter.loading")} size="sm" />
			) : comments && comments.entries.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("prCenter.review.none")}</p>
			) : (
				<ul className="flex flex-col gap-2">
					{comments?.entries.map((entry, index) => (
						<li
							className="flex flex-col gap-1 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-3 py-2"
							key={`${entry.createdAt}:${index}`}
						>
							<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
								<span className="text-(--sc-text-secondary)">@{entry.author}</span>
								{entry.kind === "review" && entry.state && (
									<Badge variant={REVIEW_STATE_TONE[entry.state] ?? "default"}>
										{t(`prCenter.review.state.${entry.state}`)}
									</Badge>
								)}
								{entry.kind === "inline" && entry.path && (
									<span className="font-mono">
										{entry.path}
										{entry.line ? `:${entry.line}` : ""}
									</span>
								)}
								<span className="ml-auto">{formatTimeAgo(entry.createdAt)}</span>
							</div>
							{entry.body.trim() && (
								<div className="text-sc-sm">
									<MarkdownRenderer content={entry.body} />
								</div>
							)}
						</li>
					))}
				</ul>
			)}
			{open && (
				<div className="flex flex-col gap-2 pt-1">
					<TextArea
						aria-label={t("prCenter.review.placeholder")}
						autoGrow
						onChange={event => setText(event.target.value)}
						onInput={event => setText(event.currentTarget.value)}
						placeholder={t("prCenter.review.placeholder")}
						rows={3}
						value={text}
					/>
					<div className="flex flex-wrap justify-end gap-2">
						<Button
							disabled={busy !== null || !text.trim()}
							icon={<MessageSquare />}
							loading={busy === "comment"}
							onClick={() => void submit("comment")}
							size="sm"
							variant="secondary"
						>
							{t("prCenter.review.comment")}
						</Button>
						<Button
							disabled={busy !== null || !text.trim()}
							icon={<XCircle />}
							loading={busy === "request_changes"}
							onClick={() => void submit("request_changes")}
							size="sm"
							variant="secondary"
						>
							{t("prCenter.review.requestChanges")}
						</Button>
						<Button
							disabled={busy !== null}
							icon={<CheckCircle2 />}
							loading={busy === "approve"}
							onClick={() => void submit("approve")}
							size="sm"
							variant="primary"
						>
							{t("prCenter.review.approve")}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
