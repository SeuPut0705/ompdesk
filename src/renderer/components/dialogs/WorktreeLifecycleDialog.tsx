/**
 * The questions omp's per-session worktree lifecycle asks (`worktree.onStart`
 * = ask, `worktree.onExit` before removing a worktree that could lose work or
 * under `ask`), answered here instead of in stock's TUI. Main owns the open
 * list (src/main/worktree-lifecycle.ts) and pushes it whole on every change;
 * the oldest one shows. Dismissing answers no: no worktree is created, none is
 * removed. Lifecycle steps that ended differently than planned arrive as toasts.
 */

import { useEffect, useState } from "react";
import type { IpcWorktreeNotice, IpcWorktreePrompt } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { Button, ConfirmDialog, Modal } from "../common";

function noticeMessage(
	notice: IpcWorktreeNotice,
	t: (key: string, params?: Record<string, string | number>) => string,
): string {
	switch (notice.kind) {
		case "create-failed":
			return t("worktreeLifecycle.createFailed", { message: notice.message });
		case "kept-changed":
			return t("worktreeLifecycle.keptChanged", { path: notice.path });
		case "kept-running":
			return t("worktreeLifecycle.keptRunning", { path: notice.path });
		case "remove-failed":
			return t("worktreeLifecycle.removeFailed", { path: notice.path, message: notice.message });
	}
}

export function WorktreeLifecycleDialog() {
	const t = useT();
	const [prompts, setPrompts] = useState<IpcWorktreePrompt[]>([]);
	const [answering, setAnswering] = useState<string | null>(null);

	useEffect(() => {
		const api = window.omp.worktreeLifecycle;
		let live = true;
		const offPrompts = api.onPrompts(next => setPrompts(next));
		// Questions opened before this renderer subscribed (a reload) still need an answer.
		void api.prompts().then(open => {
			if (live) setPrompts(open);
		});
		const offNotice = api.onNotice(notice =>
			toast({ variant: notice.kind.startsWith("kept-") ? "warning" : "error", message: noticeMessage(notice, t) }),
		);
		return () => {
			live = false;
			offPrompts();
			offNotice();
		};
	}, [t]);

	const prompt = prompts[0];
	if (!prompt) return null;
	const busy = answering === prompt.id;
	const answer = (accept: boolean) => {
		if (busy) return;
		setAnswering(prompt.id);
		void window.omp.worktreeLifecycle.answer(prompt.id, accept).finally(() => setAnswering(null));
	};

	if (prompt.kind === "start") {
		return (
			<Modal
				open
				onClose={() => answer(false)}
				title={t("worktreeLifecycle.startTitle")}
				size="sm"
				footer={
					<>
						<Button variant="secondary" onClick={() => answer(false)} disabled={busy}>
							{t("worktreeLifecycle.skip")}
						</Button>
						<Button variant="primary" onClick={() => answer(true)} loading={busy}>
							{t("worktreeLifecycle.create")}
						</Button>
					</>
				}
			>
				<p className="text-sc-md leading-relaxed text-(--sc-text-secondary)">{t("worktreeLifecycle.startBody")}</p>
				<p className="mt-2 font-mono text-sc-sm break-all text-(--sc-text-muted)" title={prompt.cwd}>
					{prompt.cwd}
				</p>
			</Modal>
		);
	}

	const risks = [
		prompt.dirty ? t("worktreeLifecycle.riskDirty") : null,
		prompt.moved ? t("worktreeLifecycle.riskMoved") : null,
		prompt.offBranch ? t("worktreeLifecycle.riskOffBranch", { branch: prompt.branch }) : null,
	].filter(risk => risk !== null);
	return (
		<ConfirmDialog
			open
			busy={busy}
			title={t("worktreeLifecycle.exitTitle")}
			message={
				<>
					<span className="block font-mono text-sc-sm break-all text-(--sc-text-muted)">
						{prompt.branch} — {prompt.path}
					</span>
					<span className="mt-2 block">
						{risks.length > 0 ? risks.join(" ") : t("worktreeLifecycle.exitBody")}
					</span>
				</>
			}
			warning={t("worktreeLifecycle.ignoredNote")}
			confirmLabel={t("worktreeLifecycle.remove")}
			cancelLabel={t("worktreeLifecycle.keep")}
			onConfirm={() => answer(true)}
			onCancel={() => answer(false)}
		/>
	);
}
