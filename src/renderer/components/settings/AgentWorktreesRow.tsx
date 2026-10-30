/**
 * Settings › Projects & launch › Worktrees (B58): the worktrees omp itself made under `~/.omp/wt/` (PR
 * checkouts, task isolation) on the tab's machine, from stock `omp worktree list --json`, and stock
 * `omp worktree clear --json` on a click, which removes only the orphaned ones. Finished agent worktrees
 * need no switch: main sweeps the landed ones by itself (worktree-orphans.ts `WorktreeSweeper`).
 */
import { FolderTree, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RpcAgentWorktree, RpcAgentWorktreeClear, RpcAgentWorktreeList } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { Button, ErrorDetail } from "../common";
import { HostScoped } from "../remote/HostScope";
import { SettingsRow } from "./SettingsLayout";
export function AgentWorktreesRows() {
	const t = useT();
	const tabRpc = useTabRpc();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const [entries, setEntries] = useState<RpcAgentWorktree[]>();
	const [cleared, setCleared] = useState<RpcAgentWorktreeClear>();
	const [error, setError] = useState<InlineFailure>();
	const [busy, setBusy] = useState<"list" | "clear" | null>(null);

	const load = useCallback(async () => {
		setBusy("list");
		setError(undefined);
		try {
			const response = await tabRpc.getAgentWorktrees();
			if (response.success) {
				// The local handler's own result shape (main/local/misc.ts get_agent_worktrees).
				const list = response.data as RpcAgentWorktreeList;
				setEntries(list.entries);
			} else setError(inlineFailure(response, t("settings.agentWorktrees.listFailed")));
		} catch (cause) {
			setError(inlineFailure(cause, t("settings.agentWorktrees.listFailed")));
		} finally {
			setBusy(null);
		}
	}, [tabRpc, t]);

	useEffect(() => {
		if (sidecarReady) void load();
	}, [sidecarReady, load]);

	const clear = async () => {
		setBusy("clear");
		setError(undefined);
		setCleared(undefined);
		try {
			const response = await tabRpc.clearAgentWorktrees();
			if (response.success) setCleared(response.data as RpcAgentWorktreeClear);
			else setError(inlineFailure(response, t("settings.agentWorktrees.clearFailed")));
		} catch (cause) {
			setError(inlineFailure(cause, t("settings.agentWorktrees.clearFailed")));
		}
		setBusy(null);
		await load();
	};

	const orphaned = entries?.filter(entry => entry.orphanReason !== undefined) ?? [];
	const failures = cleared?.results.filter(result => !result.ok) ?? [];
	return (
		<HostScoped>
			<SettingsRow
				control={
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button
							aria-label={t("settings.agentWorktrees.refresh")}
							disabled={!sidecarReady || busy !== null}
							icon={<RefreshCw />}
							loading={busy === "list"}
							onClick={() => void load()}
							size="sm"
							variant="ghost"
						/>
						{(orphaned.length > 0 || busy === "clear") && (
							<Button
								disabled={!sidecarReady || busy !== null}
								icon={<Trash2 />}
								loading={busy === "clear"}
								onClick={() => void clear()}
								size="sm"
							>
								{t("settings.agentWorktrees.clear")}
							</Button>
						)}
					</div>
				}
				description={t("settings.agentWorktrees.desc")}
				footer={
					<div className="mt-2 flex flex-col gap-1" data-agent-worktrees>
						{error && (
							<div className="text-sc-xs text-(--sc-danger)" role="alert">
								<span className="block">{error.message}</span>
								{error.cause !== undefined && <ErrorDetail error={error.cause} />}
							</div>
						)}
						{cleared && (
							<p className="text-sc-xs text-(--sc-text-muted)" role="status">
								{failures.length > 0
									? t("settings.agentWorktrees.clearedSome", {
											removed: cleared.removed,
											failed: cleared.failed,
										})
									: t("settings.agentWorktrees.cleared", { count: cleared.removed })}
							</p>
						)}
						{failures.map(result => (
							<p className="font-mono text-sc-xs break-all text-(--sc-danger)" key={result.path}>
								{result.path}
								{result.error ? ` — ${result.error}` : ""}
							</p>
						))}
						{entries && (
							<p className="text-sc-xs text-(--sc-text-muted)">
								{entries.length === 0
									? t("settings.agentWorktrees.none")
									: t("settings.agentWorktrees.summary", {
											total: entries.length,
											orphaned: orphaned.length,
										})}
							</p>
						)}
						{orphaned.length > 0 && (
							<ul className="flex flex-col gap-1">
								{orphaned.map(entry => (
									<li className="flex min-w-0 flex-col text-sc-xs" data-orphan={entry.path} key={entry.path}>
										<span className="min-w-0 font-mono break-all text-(--sc-text)">{entry.path}</span>
										<span className="min-w-0 break-words text-(--sc-text-muted)">{entry.orphanReason}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				}
				icon={<FolderTree />}
				id="setting-agent-worktrees"
				label={t("settings.agentWorktrees")}
			/>
		</HostScoped>
	);
}
