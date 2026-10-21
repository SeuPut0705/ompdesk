import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Worktree-create dialog (plan/20 — tab × worktree binding): names a new
 * branch <prefix><slug> (Settings › Project folders › Worktree branch prefix,
 * else omp/gui/) checked out at ~/.omp/wt/gui-<slug>-<hash7>, then
 * opens a tab bound to it. The create RPC rides the ACTIVE tab's sidecar
 * (baseCwd defaults to its session cwd; a Sidebar group pins it via
 * ui.worktreeDialog.baseCwd). The hash-suffixed path is computed agent-side —
 * the preview shows the branch only.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import {
	GUI_WORKTREE_BRANCH_PREFIX,
	WORKTREE_BRANCH_PREFIX_PREF,
	worktreeBranchPrefix,
} from "../../../shared/worktree-branch";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, Input, Modal } from "../common";

/** Renderer-side mirror of the agent's slugify (rpc-worktree.ts). */
function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** One toast for what `.worktreeinclude` copied and how `.ompdesk/worktree-setup` went; nothing when neither ran. */
export function announcePreparation(
	result: RpcWorktreeCreateResult,
	t: (key: string, params?: Record<string, string | number>) => string,
): void {
	const { seed, setup } = result;
	if (!seed && !setup) return;
	const lines: string[] = [];
	if (seed) {
		lines.push(
			seed.skipped.length
				? t("worktree.seedCopiedSkipped", { count: seed.copied, skipped: seed.skipped.length })
				: t("worktree.seedCopied", { count: seed.copied }),
		);
	}
	if (setup)
		lines.push(
			setup.ok ? t("worktree.setupOk") : t(setup.timedOut ? "worktree.setupTimedOut" : "worktree.setupFailed"),
		);
	const detail = [
		...(seed?.skipped.map(item => `${item.path}: ${item.reason}`) ?? []),
		...(setup && !setup.ok ? [setup.logPath, setup.outputTail] : []),
	].join("\n");
	toast({
		variant: setup && !setup.ok ? "warning" : "info",
		message: lines.join(" · "),
		...(detail ? { detail } : {}),
	});
}

export function WorktreeDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const formId = useId();
	const dialog = useUiStore(state => state.worktreeDialog);
	const close = useUiStore(state => state.closeWorktreeDialog);
	const sessionCwd = useSessionStore(state => state.cwd);
	const sidecarReady = useSessionStore(state => state.status) === "ready";

	const [name, setName] = useState("");
	const [baseRef, setBaseRef] = useState<"HEAD" | "default">("HEAD");
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState<RpcWorktreeCreateResult | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [branchPrefix, setBranchPrefix] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!dialog) return;
		setName("");
		setBaseRef("HEAD");
		setCreating(false);
		setCreated(null);
		setError(null);
		requestAnimationFrame(() => inputRef.current?.focus());
		let live = true;
		// Started inside a promise so a missing prefs API (tests) leaves the default prefix.
		void Promise.resolve()
			.then(() => window.omp.prefs.get(WORKTREE_BRANCH_PREFIX_PREF))
			.then(
				stored => {
					if (live) setBranchPrefix(worktreeBranchPrefix(stored));
				},
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, [dialog]);

	const slug = slugify(name);
	const validName = /^[a-z0-9 -]+$/i.test(name) && /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug);
	const requestClose = () => {
		if (!creating) close();
	};
	const submit = async () => {
		if (!sidecarReady || !validName || creating) return;
		setCreating(true);
		setError(null);
		try {
			let result = created;
			if (!result) {
				const response = await tabRpc.worktreeCreate(name, {
					baseCwd: dialog?.baseCwd ?? sessionCwd,
					baseRef,
					...(branchPrefix ? { branchPrefix } : {}),
				});
				if (!response.success) {
					setError(
						response.code === "not_a_repo"
							? { message: t("worktree.notARepo"), cause: response }
							: response.code === "invalid_name"
								? { message: t("worktree.invalidName"), cause: response }
								: inlineFailure(response, t("worktree.failed")),
					);
					return;
				}
				result = response.data as RpcWorktreeCreateResult;
				setCreated(result);
				announcePreparation(result, t);
			}
			const tabId = await useTabsStore.getState().openTab({
				cwd: result.path,
				worktree: { name: slug, branch: result.branch, baseCwd: result.baseCwd, path: result.path },
			});
			if (tabId) close();
			else setError({ message: t("worktree.openFailed", { path: result.path }) });
		} catch (cause) {
			setError(inlineFailure(cause, t("worktree.failed")));
		} finally {
			setCreating(false);
		}
	};

	return (
		<Modal
			open={dialog !== null}
			onClose={requestClose}
			title={t("worktree.title")}
			size="sm"
			footer={
				<>
					<Button type="button" variant="secondary" onClick={requestClose} disabled={creating}>
						{t("common.cancel")}
					</Button>
					<Button
						type="submit"
						form={formId}
						variant="primary"
						loading={creating}
						disabled={!validName || !sidecarReady}
						title={!sidecarReady ? t("sidecar.notResponding") : undefined}
					>
						{t(created ? "worktree.retryOpen" : "worktree.submit")}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="flex flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					ref={inputRef}
					label={t("worktree.nameLabel")}
					placeholder={t("worktree.namePlaceholder")}
					value={name}
					onChange={event => setName(event.target.value)}
					maxLength={41}
					disabled={creating || created !== null}
					autoFocus
				/>
				{validName && (
					<p className="text-sc-sm text-(--sc-text-muted)">
						{t("worktree.branchPreview", { branch: `${branchPrefix ?? GUI_WORKTREE_BRANCH_PREFIX}${slug}` })}
					</p>
				)}
				<p className="text-sc-sm text-(--sc-text-secondary)">{t("worktree.baseScope")}</p>
				{name && !validName && (
					<p role="alert" className="text-sc-sm text-(--sc-danger)">
						{t("worktree.invalidName")}
					</p>
				)}
				{error && <InlineNotice detail={error.cause} live title={error.message} tone="danger" />}
				<fieldset data-worktree-base disabled={creating || created !== null} className="flex flex-col gap-1.5">
					<legend className="text-sc-sm font-medium text-(--sc-text-secondary)">{t("worktree.baseLabel")}</legend>
					{(["HEAD", "default"] as const).map(value => (
						<label
							key={value}
							className="flex min-h-8 cursor-pointer items-center gap-2 text-sc-md text-(--sc-text)"
						>
							<input
								type="radio"
								name="worktree-base"
								checked={baseRef === value}
								onChange={() => setBaseRef(value)}
								className="accent-(--sc-accent)"
							/>
							{value === "HEAD" ? t("worktree.baseHead") : t("worktree.baseDefault")}
						</label>
					))}
				</fieldset>
			</form>
		</Modal>
	);
}
