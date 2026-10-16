import { Ban, ExternalLink, Play, RefreshCw, RotateCcw, ScrollText } from "lucide-react";
import { useState } from "react";
import type { GithubRunDetail } from "../../../../shared/github";
import { formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import {
	AsyncSection,
	Button,
	ConfirmDialog,
	IconButton,
	Input,
	MasterDetail,
	Modal,
	Select,
	Spinner,
} from "../../common";
import { type GithubSectionProps, GithubToolbar, ListButton, NeedsRepo, RunState, useGithubMutation } from "./shared";

type RunAction = { kind: "rerun"; failedOnly: boolean } | { kind: "cancel" };

function RunDetail({
	run,
	target,
	onChanged,
}: {
	run: GithubRunDetail;
	target: GithubSectionProps["target"];
	onChanged: () => void;
}) {
	const t = useT();
	const { busy, run: mutate } = useGithubMutation();
	const [confirm, setConfirm] = useState<RunAction | null>(null);
	const [log, setLog] = useState<{ failedOnly: boolean } | null>(null);
	const logLoad = useGithubLoad(
		log ? { ...target, op: "run_log", id: run.id, failedOnly: log.failedOnly } : null,
		`${run.id}|${log?.failedOnly}`,
	);
	const done = run.status === "completed";
	const failed = done && run.conclusion !== "success" && run.conclusion !== "skipped";
	const act = (action: RunAction) =>
		void mutate(
			action.kind,
			() =>
				action.kind === "cancel"
					? github({ ...target, op: "run_cancel", id: run.id })
					: github({ ...target, op: "run_rerun", id: run.id, failedOnly: action.failedOnly }),
			t("github.actionFailed"),
			t(action.kind === "cancel" ? "github.runs.cancelled" : "github.runs.rerunStarted"),
		).then(ok => {
			setConfirm(null);
			if (ok) onChanged();
		});
	return (
		<article className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10" data-github-run={run.id}>
			<header className="flex flex-col gap-2">
				<h3 className="flex items-center gap-2 text-sc-lg font-semibold text-(--sc-text)">
					<RunState conclusion={run.conclusion} status={run.status} />
					<span className="min-w-0">{run.title || run.workflow}</span>
				</h3>
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<span>{run.workflow}</span>
					<span className="font-mono">{run.branch}</span>
					<span>{run.event}</span>
					<span>{formatTimeAgo(run.createdAt)}</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{done && (
						<Button
							icon={<RotateCcw />}
							loading={busy === "rerun"}
							onClick={() => setConfirm({ kind: "rerun", failedOnly: false })}
							size="sm"
							variant="secondary"
						>
							{t("github.runs.rerunAll")}
						</Button>
					)}
					{failed && (
						<Button
							icon={<RotateCcw />}
							onClick={() => setConfirm({ kind: "rerun", failedOnly: true })}
							size="sm"
							variant="secondary"
						>
							{t("github.runs.rerunFailed")}
						</Button>
					)}
					{!done && (
						<Button
							icon={<Ban />}
							loading={busy === "cancel"}
							onClick={() => setConfirm({ kind: "cancel" })}
							size="sm"
							variant="secondary"
						>
							{t("github.runs.cancel")}
						</Button>
					)}
					<Button icon={<ScrollText />} onClick={() => setLog({ failedOnly: false })} size="sm" variant="ghost">
						{t("github.runs.log")}
					</Button>
					{failed && (
						<Button icon={<ScrollText />} onClick={() => setLog({ failedOnly: true })} size="sm" variant="ghost">
							{t("github.runs.failedLog")}
						</Button>
					)}
					<Button
						icon={<ExternalLink />}
						onClick={() => void window.omp.system.openExternal(run.url)}
						size="sm"
						variant="ghost"
					>
						{t("github.openOnGithub")}
					</Button>
				</div>
			</header>
			<section aria-label={t("github.runs.jobs")}>
				<h4 className="mb-2 text-sc-sm font-semibold text-(--sc-text)">{t("github.runs.jobs")}</h4>
				{run.jobs.length === 0 ? (
					<p className="text-sc-sm text-(--sc-text-muted)">{t("github.runs.noJobs")}</p>
				) : (
					<ul className="flex flex-col gap-1">
						{run.jobs.map((job, index) => (
							<li className="flex items-center gap-2 text-sc-sm text-(--sc-text)" key={`${index}:${job.name}`}>
								<RunState conclusion={job.conclusion} status={job.status} />
								{job.name}
							</li>
						))}
					</ul>
				)}
			</section>
			{log && (
				<section aria-label={t(log.failedOnly ? "github.runs.failedLog" : "github.runs.log")}>
					<AsyncSection error={logLoad.error} loading={logLoad.loading} onRetry={logLoad.reload}>
						{logLoad.data && (
							<>
								{logLoad.data.truncated && (
									<p className="mb-1 text-sc-xs text-(--sc-text-muted)">{t("github.runs.logTruncated")}</p>
								)}
								<pre
									className="max-h-[60vh] overflow-auto rounded-(--sc-radius-md) border border-(--sc-border) bg-(--sc-surface-1) p-3 font-mono text-sc-xs whitespace-pre text-(--sc-text)"
									data-github-log
								>
									{logLoad.data.text || t("github.runs.logEmpty")}
								</pre>
							</>
						)}
					</AsyncSection>
				</section>
			)}
			<ConfirmDialog
				busy={busy !== null}
				confirmLabel={t(
					confirm?.kind === "cancel"
						? "github.runs.cancel"
						: confirm?.failedOnly
							? "github.runs.rerunFailed"
							: "github.runs.rerunAll",
				)}
				message={t(confirm?.kind === "cancel" ? "github.runs.cancelConfirm" : "github.runs.rerunConfirm", {
					name: run.title || run.workflow,
				})}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					if (confirm) act(confirm);
				}}
				open={confirm !== null}
				title={t(confirm?.kind === "cancel" ? "github.runs.cancelTitle" : "github.runs.rerunTitle")}
			/>
		</article>
	);
}

export function GithubActions({ target, repoName, targetKey }: GithubSectionProps) {
	const t = useT();
	const [workflow, setWorkflow] = useState("");
	const [selected, setSelected] = useState<number | null>(null);
	const [dispatching, setDispatching] = useState(false);
	const [ref, setRef] = useState("");
	const { busy, run } = useGithubMutation();
	const workflows = useGithubLoad(repoName ? { ...target, op: "workflow_list" } : null, targetKey);
	const runs = useGithubLoad(
		repoName ? { ...target, op: "run_list", workflow: workflow || undefined } : null,
		`${targetKey}|${workflow}`,
	);
	const detail = useGithubLoad(
		repoName && selected !== null ? { ...target, op: "run_get", id: selected } : null,
		`${targetKey}|${selected}`,
	);
	if (!repoName) return <NeedsRepo />;
	const chosen = workflows.data?.find(entry => String(entry.id) === workflow);
	const rows = runs.data ?? [];
	return (
		<>
			<GithubToolbar>
				<Select
					aria-label={t("github.runs.workflow")}
					controlSize="sm"
					onChange={event => setWorkflow(event.target.value)}
					options={[
						{ value: "", label: t("github.runs.allWorkflows") },
						...(workflows.data ?? []).map(entry => ({ value: String(entry.id), label: entry.name })),
					]}
					value={workflow}
				/>
				{workflows.loading && <Spinner size="sm" />}
				<Button
					disabled={chosen?.state !== "active"}
					icon={<Play />}
					onClick={() => setDispatching(true)}
					size="sm"
					title={chosen ? undefined : t("github.runs.pickWorkflow")}
					variant="secondary"
				>
					{t("github.runs.dispatch")}
				</Button>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={runs.loading}
					onClick={() => {
						runs.reload();
						detail.reload();
					}}
				/>
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
							{detail.data && (
								<RunDetail
									key={detail.data.id}
									onChanged={() => {
										runs.reload();
										detail.reload();
									}}
									run={detail.data}
									target={target}
								/>
							)}
						</AsyncSection>
					)
				}
				label={t("github.runs.list")}
				list={
					<AsyncSection
						emptyLabel={t("github.runs.empty")}
						empty={rows.length === 0}
						error={runs.error}
						hasData={rows.length > 0}
						loading={runs.loading && !runs.data}
						onRetry={runs.reload}
					>
						<ul className="flex flex-col gap-0.5">
							{rows.map(item => (
								<ListButton active={item.id === selected} key={item.id} onSelect={() => setSelected(item.id)}>
									<span className="flex w-full items-center gap-2">
										<RunState conclusion={item.conclusion} status={item.status} />
										<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">
											{item.title || item.workflow}
										</span>
									</span>
									<span className="flex w-full items-center gap-2 pl-6 text-sc-xs text-(--sc-text-muted)">
										<span className="min-w-0 truncate">{item.workflow}</span>
										<span className="min-w-0 flex-1 truncate font-mono">{item.branch}</span>
										<span className="shrink-0">{formatTimeAgo(item.createdAt)}</span>
									</span>
								</ListButton>
							))}
						</ul>
					</AsyncSection>
				}
				onBack={() => setSelected(null)}
				open={selected !== null}
			/>
			<Modal
				footer={
					<>
						<Button onClick={() => setDispatching(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button
							disabled={!ref.trim()}
							form="github-dispatch"
							loading={busy === "dispatch"}
							type="submit"
							variant="primary"
						>
							{t("github.runs.dispatchConfirm")}
						</Button>
					</>
				}
				onClose={() => setDispatching(false)}
				open={dispatching && chosen !== undefined}
				size="sm"
				title={t("github.runs.dispatchTitle", { name: chosen?.name ?? "" })}
			>
				<form
					className="flex flex-col gap-3"
					id="github-dispatch"
					onSubmit={event => {
						event.preventDefault();
						if (!chosen || !ref.trim()) return;
						void run(
							"dispatch",
							() => github({ ...target, op: "workflow_dispatch", workflow: String(chosen.id), ref: ref.trim() }),
							t("github.actionFailed"),
							t("github.runs.dispatched"),
						).then(ok => {
							if (!ok) return;
							setDispatching(false);
							runs.reload();
						});
					}}
				>
					<p className="text-sc-sm text-(--sc-text-muted)">
						{t("github.runs.dispatchHint", { path: chosen?.path ?? "" })}
					</p>
					<Input
						autoFocus
						label={t("github.runs.ref")}
						mono
						onChange={event => setRef(event.target.value)}
						placeholder="main"
						value={ref}
					/>
				</form>
			</Modal>
		</>
	);
}
