/**
 * The Changes panel's source-control row: branch picker, Fetch, Pull (with
 * the behind count) and Push or Publish (with the ahead count), a menu for
 * stash, pop and undo-last-commit, and the banner of a merge, rebase,
 * cherry-pick or revert that stopped on conflicts.
 */
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	CloudUpload,
	MoreHorizontal,
	RefreshCcw,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import type { RpcGitHead, RpcGitRemoteResult } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { Button, ConfirmDialog, IconButton, InlineNotice, MenuButton } from "../../common";
import { BranchPicker } from "./BranchPicker";
import type { NameRequest } from "./NameDialog";
import type { ScmRunner } from "./use-scm-action";

export function SourceControlBar({
	rpc,
	head,
	conflicts,
	runner,
	requestName,
}: {
	rpc: TabRpc;
	head: RpcGitHead;
	conflicts: number;
	runner: ScmRunner;
	requestName: (request: NameRequest) => void;
}) {
	const t = useT();
	const [confirm, setConfirm] = useState<"undo" | "abort" | null>(null);
	const { busy, run } = runner;
	const blocked = busy !== null || head.operation !== null;
	const remoteReason = !head.hasRemote ? t("scm.remote.none") : !head.branch ? t("scm.remote.detached") : undefined;
	const operationLabel = head.operation ? t(`scm.operation.${head.operation}`) : "";
	return (
		<>
			<div className="flex flex-wrap items-center gap-1 border-b border-(--sc-divider) px-2 py-1.5" data-scm-bar>
				<BranchPicker branch={head.branch} disabled={blocked} requestName={requestName} rpc={rpc} runner={runner} />
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					<IconButton
						disabled={blocked || !head.hasRemote}
						icon={<RefreshCcw />}
						label={head.hasRemote ? t("scm.remote.fetch") : t("scm.remote.none")}
						loading={busy === "fetch"}
						onClick={() =>
							void run(
								"fetch",
								{ type: "git_remote", action: "fetch" },
								{ failure: t("scm.remote.fetchFailed") },
							)
						}
						size="sm"
					/>
					<Button
						disabled={blocked || remoteReason !== undefined || !head.upstream}
						icon={<ArrowDown />}
						loading={busy === "pull"}
						onClick={() =>
							void run("pull", { type: "git_remote", action: "pull" }, { failure: t("scm.remote.pullFailed") })
						}
						size="sm"
						title={
							remoteReason ??
							(head.upstream
								? t("scm.remote.pullTitle", { upstream: head.upstream })
								: t("scm.remote.noUpstream"))
						}
						variant="ghost"
					>
						{t("scm.remote.pull")}
						{head.behind > 0 && <span className="tabular-nums text-(--sc-text-muted)">{head.behind}</span>}
					</Button>
					{head.upstream ? (
						<Button
							disabled={blocked || remoteReason !== undefined}
							icon={<ArrowUp />}
							loading={busy === "push"}
							onClick={() =>
								void run(
									"push",
									{ type: "git_remote", action: "push" },
									{ failure: t("scm.remote.pushFailed") },
								)
							}
							size="sm"
							title={remoteReason ?? t("scm.remote.pushTitle", { upstream: head.upstream })}
							variant="ghost"
						>
							{t("scm.remote.push")}
							{head.ahead > 0 && <span className="tabular-nums text-(--sc-text-muted)">{head.ahead}</span>}
						</Button>
					) : (
						<Button
							disabled={blocked || remoteReason !== undefined}
							icon={<CloudUpload />}
							loading={busy === "push"}
							onClick={() =>
								void run<RpcGitRemoteResult>(
									"push",
									{ type: "git_remote", action: "push" },
									{
										failure: t("scm.remote.pushFailed"),
										success: t("scm.remote.published", { branch: head.branch ?? "" }),
									},
								)
							}
							size="sm"
							title={remoteReason ?? t("scm.remote.publishTitle")}
							variant="ghost"
						>
							{t("scm.remote.publish")}
						</Button>
					)}
					<MenuButton
						align="end"
						disabled={busy !== null}
						icon={<MoreHorizontal />}
						items={[
							{
								id: "stash",
								label: t("scm.stash.push"),
								icon: Archive,
								disabled: head.operation !== null,
								onSelect: () =>
									requestName({
										title: t("scm.stash.push"),
										label: t("scm.stash.messageLabel"),
										submitLabel: t("scm.stash.submit"),
										optional: true,
										onSubmit: message =>
											void run(
												"stash",
												{ type: "git_stash", action: "push", message: message || undefined },
												{ failure: t("scm.stash.failed"), success: t("scm.stash.done") },
											),
									}),
							},
							{
								id: "pop",
								label: t("scm.stash.pop"),
								icon: ArchiveRestore,
								hint: head.stashes > 0 ? String(head.stashes) : undefined,
								disabled: head.stashes === 0 || head.operation !== null,
								onSelect: () =>
									void run("pop", { type: "git_stash", action: "pop" }, { failure: t("scm.stash.popFailed") }),
							},
							{
								id: "undo",
								label: t("scm.undoCommit"),
								icon: Undo2,
								disabled: head.operation !== null,
								separatorBefore: true,
								onSelect: () => setConfirm("undo"),
							},
						]}
						label={t("scm.more")}
						size="sm"
					/>
				</div>
			</div>
			{head.operation && (
				<InlineNotice
					action={
						<div className="flex gap-1">
							<Button
								disabled={busy !== null || conflicts > 0}
								loading={busy === "continue"}
								onClick={() =>
									void run(
										"continue",
										{ type: "git_operation", action: "continue" },
										{ failure: t("scm.operation.continueFailed") },
									)
								}
								size="sm"
								variant="secondary"
							>
								{t("scm.operation.continue")}
							</Button>
							<Button disabled={busy !== null} onClick={() => setConfirm("abort")} size="sm" variant="ghost">
								{t("scm.operation.abort")}
							</Button>
						</div>
					}
					className="px-3"
					detail={conflicts > 0 ? t("scm.operation.conflicts", { count: conflicts }) : t("scm.operation.resolved")}
					live
					title={t("scm.operation.inProgress", { operation: operationLabel })}
					tone={conflicts > 0 ? "warning" : "info"}
				/>
			)}
			<ConfirmDialog
				confirmLabel={confirm === "undo" ? t("scm.undoCommit") : t("scm.operation.abort")}
				message={
					confirm === "undo"
						? t("scm.undoCommitBody")
						: t("scm.operation.abortBody", { operation: operationLabel })
				}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					const action = confirm;
					setConfirm(null);
					if (action === "undo")
						void run("undo", { type: "git_undo_commit" }, { failure: t("scm.undoCommitFailed") });
					else if (action === "abort")
						void run(
							"abort",
							{ type: "git_operation", action: "abort" },
							{ failure: t("scm.operation.abortFailed") },
						);
				}}
				open={confirm !== null}
				title={
					confirm === "undo"
						? t("scm.undoCommitTitle")
						: t("scm.operation.abortTitle", { operation: operationLabel })
				}
				warning={confirm === "undo" && head.upstream && head.ahead === 0 ? t("scm.undoCommitPushed") : undefined}
			/>
		</>
	);
}
