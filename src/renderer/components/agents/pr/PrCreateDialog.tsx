/**
 * Create pull request (Dialog md, opened from Agents › Pull requests):
 * title/body form with an AI draft button that fills both fields from the
 * head branch's commits + diffstat (pr_draft, user-editable after), a draft
 * checkbox (applied on submit), and pr_create on submit. The head branch
 * reads from the active tab's live git status; base defaults to the repo's
 * default branch.
 */

import { Sparkles } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { RpcPrCreateResult, RpcPrDraftResult } from "../../../../shared/rpc-types";
import { useGitStatus } from "../../../hooks/use-git-status";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usePrCenterStore } from "../../../stores/pr-center";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { Button, Input, Modal, TextArea } from "../../common";

export function PrCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const repo = usePrCenterStore(state => state.repo);
	const { status: git } = useGitStatus();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [draft, setDraft] = useState(true);
	const [drafting, setDrafting] = useState(false);
	const [creating, setCreating] = useState(false);
	const formId = useId();

	useEffect(() => {
		if (!open) return;
		setTitle("");
		setBody("");
		setDraft(true);
		setDrafting(false);
		setCreating(false);
	}, [open]);

	const head = git?.branch ?? undefined;
	const base = repo?.available ? (repo.defaultBranch ?? undefined) : undefined;

	const aiDraft = async () => {
		if (!sidecarReady || drafting) return;
		setDrafting(true);
		try {
			const response = await tabRpc.prDraft({ base, head });
			if (!response.success) {
				toast({ variant: "error", title: t("prCenter.draftFailed"), message: response.error });
				return;
			}
			// pr_draft success arm carries RpcPrDraftResult — one named assertion home.
			const result = response.data as RpcPrDraftResult | undefined;
			if (result) {
				setTitle(result.title);
				setBody(result.body);
			}
		} catch (error) {
			toast({ variant: "error", title: t("prCenter.draftFailed"), message: String(error) });
		} finally {
			setDrafting(false);
		}
	};

	const submit = async () => {
		if (!sidecarReady || !title.trim() || creating) return;
		setCreating(true);
		try {
			const response = await tabRpc.prCreate({ title: title.trim(), body, base, head, draft });
			if (!response.success) {
				toast({ variant: "error", title: t("prCenter.createFailed"), message: response.error });
				return;
			}
			const result = response.data as RpcPrCreateResult | undefined;
			if (result) {
				toast({ variant: "success", message: t("prCenter.created", { number: String(result.number) }) });
				void window.omp.system.openExternal(result.url);
			}
			void usePrCenterStore.getState().refresh();
			onClose();
		} catch (error) {
			toast({ variant: "error", title: t("prCenter.createFailed"), message: String(error) });
		} finally {
			setCreating(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!sidecarReady || title.trim().length === 0}
						form={formId}
						loading={creating}
						title={!sidecarReady ? t("common.notConnected") : undefined}
						type="submit"
						variant="primary"
					>
						{t("prCenter.createSubmit")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={t("prCenter.createTitle")}
		>
			<form
				className="flex flex-col gap-4"
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<p className="font-mono text-sc-sm text-(--sc-text-muted)">
					{t("prCenter.branches", { head: head ?? "?", base: base ?? "?" })}
				</p>
				<div className="flex items-end gap-2">
					<div className="flex-1">
						<Input
							autoFocus
							label={t("prCenter.titleLabel")}
							maxLength={120}
							onChange={event => setTitle(event.target.value)}
							placeholder={t("prCenter.titlePlaceholder")}
							value={title}
						/>
					</div>
					<Button
						disabled={!sidecarReady}
						icon={<Sparkles />}
						loading={drafting}
						onClick={() => void aiDraft()}
						title={!sidecarReady ? t("common.notConnected") : undefined}
						type="button"
						variant="secondary"
					>
						{t("prCenter.aiDraft")}
					</Button>
				</div>
				<TextArea
					label={t("prCenter.bodyLabel")}
					onChange={event => setBody(event.target.value)}
					placeholder={t("prCenter.bodyPlaceholder")}
					rows={10}
					value={body}
				/>
				<label className="flex w-fit cursor-pointer items-center gap-2 text-sc-md text-(--sc-text)">
					<input
						checked={draft}
						className="size-4 accent-(--sc-accent)"
						onChange={event => setDraft(event.target.checked)}
						type="checkbox"
					/>
					{t("prCenter.asDraft")}
				</label>
			</form>
		</Modal>
	);
}
