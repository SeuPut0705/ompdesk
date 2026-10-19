/**
 * Memory › Maintenance: lint findings (rule-based, writes nothing), the retention sweep (preview first), and
 * Delete all memory (typed confirmation).
 */
import { Trash2 } from "lucide-react";
import { useState } from "react";
import type {
	AiMemoryLintFinding,
	AiMemoryProjectRef,
	AiMemoryState,
	AiMemorySweep,
} from "../../../../shared/ai-memory";
import { useT } from "../../../lib/i18n";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { Badge, Button, ConfirmDialog, Input, Modal } from "../../common";
import { SettingsRow } from "../SettingsLayout";
import { MutedLine, useMemoryAction } from "./memory-ui";
import { projectKey } from "./use-memory-read";

export function MemoryMaintenance({ project, state }: { project: AiMemoryProjectRef; state: AiMemoryState }) {
	const t = useT();
	const { busy, run } = useMemoryAction();
	const [findings, setFindings] = useState<{ key: string; list: AiMemoryLintFinding[] } | null>(null);
	const [preview, setPreview] = useState<{ key: string; sweep: AiMemorySweep } | null>(null);
	const [confirmSweep, setConfirmSweep] = useState(false);
	const [purge, setPurge] = useState(false);
	const [typed, setTyped] = useState("");
	const key = projectKey(project);
	const lint = findings?.key === key ? findings.list : null;
	const sweep = preview?.key === key ? preview.sweep : null;
	const actionable = sweep
		? sweep.evicted + sweep.compacted + sweep.merged + sweep.expired + sweep.observationsPruned > 0
		: false;
	const word = t("memory.maint.purge.word");

	return (
		<div className="flex flex-col" data-memory-maintenance>
			<SettingsRow
				control={
					<Button
						data-memory-lint-run
						loading={busy === "lint"}
						onClick={() =>
							void run("lint", async () => {
								const list = await window.omp.aiMemory.lint(project);
								setFindings({ key, list });
							})
						}
						size="sm"
						variant="secondary"
					>
						{t("memory.maint.lint.run")}
					</Button>
				}
				description={t("memory.maint.lint.info")}
				id="setting-memory-lint"
				label={t("memory.maint.lint")}
			/>
			{lint && lint.length === 0 && <MutedLine data-memory-lint-none>{t("memory.maint.lint.none")}</MutedLine>}
			{lint && lint.length > 0 && (
				<ul className="flex flex-col pb-2" data-memory-lint-list>
					{lint.map(finding => (
						<li
							className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-(--sc-divider) px-1 py-1.5 text-sc-sm"
							data-memory-finding={finding.kind}
							key={`${finding.kind}:${finding.message}`}
						>
							<Badge variant={finding.severity === "error" ? "error" : "warning"}>{finding.kind}</Badge>
							<span className="min-w-0 flex-1 truncate" title={finding.message}>
								{finding.message}
							</span>
							{finding.pages.slice(0, 3).map(path => (
								<Button
									key={path}
									onClick={() => useMemoryPageStore.getState().openPage({ ...project, path })}
									size="sm"
									title={path}
									variant="ghost"
								>
									{path.split("/").pop()}
								</Button>
							))}
						</li>
					))}
				</ul>
			)}
			<SettingsRow
				control={
					<span className="flex items-center gap-1">
						<Button
							data-memory-sweep-preview
							loading={busy === "preview"}
							onClick={() =>
								void run("preview", async () => {
									const result = await window.omp.aiMemory.sweep(project, true);
									setPreview({ key, sweep: result });
								})
							}
							size="sm"
							variant="secondary"
						>
							{t("memory.maint.sweep.preview")}
						</Button>
						<Button
							data-memory-sweep-run
							disabled={!actionable}
							onClick={() => setConfirmSweep(true)}
							size="sm"
							variant="danger"
						>
							{t("memory.maint.sweep.run")}
						</Button>
					</span>
				}
				description={t("memory.maint.sweep.info")}
				id="setting-memory-sweep"
				label={t("memory.maint.sweep")}
			>
				{sweep && (
					<span className="block text-sc-xs text-(--sc-text-muted)" data-memory-sweep-result>
						{t(sweep.dryRun ? "memory.maint.sweep.would" : "memory.maint.sweep.done", {
							evaluated: sweep.evaluated,
							evicted: sweep.evicted,
							compacted: sweep.compacted,
							merged: sweep.merged,
							expired: sweep.expired,
							observations: sweep.observationsPruned,
						})}
					</span>
				)}
			</SettingsRow>
			<SettingsRow
				control={
					<Button
						data-memory-purge
						disabled={state.phase === "starting"}
						icon={<Trash2 />}
						onClick={() => {
							setTyped("");
							setPurge(true);
						}}
						size="sm"
						variant="danger"
					>
						{t("memory.maint.purge")}
					</Button>
				}
				description={t("memory.maint.purge.info")}
				id="setting-aiMemory-purge"
				label={t("memory.maint.purge")}
			/>
			<ConfirmDialog
				busy={busy === "sweep"}
				confirmLabel={t("memory.maint.sweep.run")}
				message={t("memory.maint.sweep.confirm")}
				onCancel={() => setConfirmSweep(false)}
				onConfirm={() =>
					void run(
						"sweep",
						async () => {
							await window.omp.aiMemory.sweep(project, false);
							setPreview(null);
							return true;
						},
						t("memory.maint.sweep.ran"),
					).then(() => setConfirmSweep(false))
				}
				open={confirmSweep}
				title={t("memory.maint.sweep.title")}
			/>
			<Modal
				footer={
					<>
						<Button onClick={() => setPurge(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button
							data-memory-purge-confirm
							disabled={typed.trim() !== word}
							loading={busy === "purge"}
							onClick={() =>
								void run("purge", () => window.omp.aiMemory.purge(), t("memory.maint.purged")).then(() =>
									setPurge(false),
								)
							}
							variant="danger"
						>
							{t("memory.maint.purge")}
						</Button>
					</>
				}
				onClose={() => setPurge(false)}
				open={purge}
				size="sm"
				title={t("memory.maint.purge.title")}
			>
				<div className="flex flex-col gap-3 text-sc-md text-(--sc-text-secondary)">
					<p>{t("memory.maint.purge.message")}</p>
					<Input
						autoComplete="off"
						data-memory-purge-input
						label={t("memory.maint.purge.type", { word })}
						onChange={event => setTyped(event.target.value)}
						value={typed}
					/>
				</div>
			</Modal>
		</div>
	);
}
