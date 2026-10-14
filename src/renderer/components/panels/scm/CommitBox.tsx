/**
 * Commit form above the changed files: message (first line is the summary),
 * a message written by stock `omp commit --dry-run` from the staged diff,
 * amend (prefilled with the last message) and Commit with the staged count
 * and branch. Conflicts and an empty index block it with the reason shown.
 */
import { GitCommitHorizontal, Sparkles } from "lucide-react";
import { useId, useState } from "react";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { Button, IconButton, TextArea } from "../../common";
import type { ScmRunner } from "./use-scm-action";

export function CommitBox({
	rpc,
	branch,
	staged,
	conflicts,
	runner,
}: {
	rpc: TabRpc;
	branch: string | null;
	staged: number;
	conflicts: number;
	runner: ScmRunner;
}) {
	const t = useT();
	const amendId = useId();
	const [message, setMessage] = useState("");
	const [amend, setAmend] = useState(false);
	const [warning, setWarning] = useState<string | null>(null);
	const { busy, run } = runner;
	const summary = message.trim().split("\n")[0]?.trim() ?? "";
	const blockedReason =
		conflicts > 0
			? t("scm.commit.conflicts", { count: conflicts })
			: !amend && staged === 0
				? t("scm.commit.nothingStaged")
				: !summary
					? t("scm.commit.needsMessage")
					: undefined;

	const commit = async () => {
		if (blockedReason || busy) return;
		const result = await run<{ sha: string }>(
			"commit",
			{ type: "git_commit", message, amend },
			{ failure: t("scm.commit.failed") },
		);
		if (result) {
			setMessage("");
			setAmend(false);
			setWarning(null);
		}
	};

	const generate = async () => {
		setWarning(null);
		const result = await run<{ message: string; warning?: string }>(
			"generate",
			{ type: "git_commit_message" },
			{ failure: t("scm.commit.generateFailed") },
		);
		if (!result) return;
		setMessage(result.message);
		if (result.warning) setWarning(result.warning);
	};

	const toggleAmend = async (next: boolean) => {
		setAmend(next);
		if (!next || message.trim()) return;
		const response = await rpc.command({ type: "git_last_commit_message" }).catch(() => null);
		const data = response?.success ? response.data : null;
		if (data && typeof data === "object" && "message" in data && typeof data.message === "string")
			setMessage(data.message);
	};

	return (
		<div className="flex flex-col gap-1.5 border-b border-(--sc-divider) px-3 py-2" data-commit-box>
			<div className="relative">
				<TextArea
					aria-label={t("scm.commit.messageLabel")}
					autoGrow
					className="max-h-40 pr-9"
					disabled={busy === "generate"}
					onChange={event => setMessage(event.target.value)}
					onInput={event => setMessage(event.currentTarget.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void commit();
						}
					}}
					placeholder={t("scm.commit.placeholder")}
					rows={2}
					value={message}
				/>
				<IconButton
					className="absolute top-1 right-1"
					disabled={busy !== null || staged === 0}
					icon={<Sparkles />}
					label={staged === 0 ? t("scm.commit.generateNeedsStaged") : t("scm.commit.generate")}
					loading={busy === "generate"}
					onClick={() => void generate()}
					size="sm"
				/>
			</div>
			{warning && (
				<p className="text-sc-xs text-(--sc-warning)" role="status">
					{t("scm.commit.generateWarning", { detail: warning })}
				</p>
			)}
			<div className="flex items-center gap-2">
				<label className="flex items-center gap-1.5 text-sc-xs text-(--sc-text-secondary)" htmlFor={amendId}>
					<input
						checked={amend}
						className="size-4 shrink-0 accent-(--sc-accent) disabled:cursor-not-allowed"
						disabled={busy !== null}
						id={amendId}
						onChange={event => void toggleAmend(event.target.checked)}
						type="checkbox"
					/>
					{t("scm.commit.amend")}
				</label>
				<Button
					className="ml-auto min-w-0"
					disabled={blockedReason !== undefined || busy !== null}
					icon={<GitCommitHorizontal />}
					loading={busy === "commit"}
					onClick={() => void commit()}
					size="sm"
					title={blockedReason ?? t("scm.commit.shortcut")}
					variant="primary"
				>
					<span className="truncate">
						{amend
							? t("scm.commit.amendSubmit")
							: branch
								? t("scm.commit.submit", { count: staged, branch })
								: t("scm.commit.submitDetached", { count: staged })}
					</span>
				</Button>
			</div>
			{blockedReason && message.trim() && <p className="text-sc-xs text-(--sc-text-muted)">{blockedReason}</p>}
		</div>
	);
}
