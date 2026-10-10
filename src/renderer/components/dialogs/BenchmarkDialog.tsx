import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { IpcBenchmarkModelReport, IpcBenchmarkProfile, IpcBenchmarkRunResult } from "../../../shared/ipc-types";
import { formatUsd } from "../../lib/chart";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useFocusedTabDevice } from "../../stores/remote";
import { Button, ErrorDetail, Input, Modal, Select } from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";

function formatMetric(value: number, suffix = ""): string {
	return Number.isFinite(value) ? `${value.toFixed(value >= 100 ? 0 : 1)}${suffix}` : "—";
}

function resultError(report: IpcBenchmarkModelReport): string {
	return report.results.find(result => !result.ok)?.error ?? "—";
}

export function BenchmarkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const activeModel = useModelStore(state => state.model);
	// `omp bench` runs where the focused tab's omp does; the abort goes to the same machine.
	const device = useFocusedTabDevice();
	const runDevice = useRef<string | undefined>(undefined);
	const [models, setModels] = useState("");
	const [profile, setProfile] = useState<IpcBenchmarkProfile>("mix");
	const [runs, setRuns] = useState(3);
	const [parallel, setParallel] = useState(2);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);
	// The benchmark writes its diagnostics to stderr on both success and failure,
	// so a run that produced no rows still has a reason to show.
	const [stderr, setStderr] = useState<string | null>(null);
	const [result, setResult] = useState<IpcBenchmarkRunResult | null>(null);

	useEffect(() => {
		if (!open || models) return;
		if (activeModel) setModels(`${activeModel.provider}/${activeModel.id}`);
	}, [activeModel, models, open]);

	const close = () => {
		if (!running) onClose();
	};
	const selectors = [
		...new Set(
			models
				.split(/[\s,]+/)
				.map(value => value.trim())
				.filter(Boolean),
		),
	];
	const valid =
		selectors.length > 0 &&
		selectors.length <= 8 &&
		selectors.every(value => value.length <= 200 && !value.startsWith("-")) &&
		Number.isInteger(runs) &&
		runs >= 1 &&
		runs <= 20 &&
		Number.isInteger(parallel) &&
		parallel >= 1 &&
		parallel <= 8;
	const abort = async () => {
		try {
			await window.omp.bench.abort(runDevice.current);
		} catch (cause) {
			setError(inlineFailure(cause, t("benchmark.abortFailed")));
		}
	};
	const run = async () => {
		if (running || !valid) return;
		setRunning(true);
		setError(null);
		setStderr(null);
		try {
			runDevice.current = device;
			const next = await window.omp.bench.run({ models: selectors, profile, runs, parallel }, device);
			const output = next.stderr?.trim();
			setStderr(output ? output : null);
			if (next.success) setResult(next);
			else setError(inlineFailure(next, t("benchmark.failed")));
		} catch (cause) {
			setError(inlineFailure(cause, t("benchmark.failed")));
		} finally {
			setRunning(false);
		}
	};

	return (
		<Modal
			onClose={close}
			open={open}
			size="lg"
			title={t("benchmark.title")}
			description={t("benchmark.description")}
			footer={
				<>
					{running && (
						<Button onClick={() => void abort()} variant="danger">
							{t("common.cancel")}
						</Button>
					)}
					<Button disabled={!valid || running} loading={running} onClick={() => void run()} variant="primary">
						{t("benchmark.run")}
					</Button>
				</>
			}
		>
			<div className="space-y-4">
				<div className="grid grid-cols-[minmax(0,1fr)_9rem_5.5rem_5.5rem] gap-3 max-md:grid-cols-2 max-sm:grid-cols-1">
					<div className="space-y-2">
						<span className="text-sc-md">{t("benchmark.models")}</span>
						<ModelValueSelect
							kind="model"
							value=""
							placeholder={t("benchmark.addModel")}
							disabled={running || selectors.length >= 8}
							onCommit={value => {
								if (value) setModels([...new Set([...selectors, value])].join(", "));
							}}
						/>
						<div className="flex flex-wrap gap-1">
							{selectors.map(selector => (
								<button
									type="button"
									disabled={running}
									className="flex min-h-(--sc-hit-min) max-w-full items-center gap-1 rounded-(--sc-radius-sm) border border-(--sc-border-subtle) px-2 py-1 text-sc-xs hover:bg-(--sc-hover) disabled:opacity-50"
									key={selector}
									onClick={() => setModels(selectors.filter(value => value !== selector).join(", "))}
									aria-label={t("benchmark.removeModel", { model: selector })}
								>
									<span className="truncate">{selector}</span>
									<X aria-hidden className="size-(--sc-icon-sm)" />
								</button>
							))}
						</div>
					</div>
					<Select
						label={t("benchmark.profile")}
						disabled={running}
						onChange={event => setProfile(event.target.value as IpcBenchmarkProfile)}
						value={profile}
						options={(["mix", "chat", "prefill", "generation"] as const).map(value => ({
							value,
							label: t(`benchmark.profile.${value}`),
						}))}
					/>
					<Input
						disabled={running}
						label={t("benchmark.runs")}
						max={20}
						min={1}
						onChange={event => setRuns(Number(event.target.value))}
						type="number"
						value={runs}
					/>
					<Input
						disabled={running}
						label={t("benchmark.parallel")}
						max={8}
						min={1}
						onChange={event => setParallel(Number(event.target.value))}
						type="number"
						value={parallel}
					/>
				</div>
				<p className="text-sc-sm text-(--sc-text-muted)">
					{t("benchmark.requestScale", {
						count: selectors.length * (Number.isInteger(runs) && runs > 0 ? runs : 0),
					})}
				</p>

				{(error ?? stderr) && (
					<div
						role={error ? "alert" : "status"}
						className={cx(
							"rounded-(--sc-radius-md) border p-3 text-sc-sm",
							error
								? "border-(--sc-danger) bg-(--sc-danger-soft) text-(--sc-danger)"
								: "border-(--sc-border-subtle) text-(--sc-text-muted)",
						)}
					>
						{error && (
							<div>
								{error.message}
								<ErrorDetail className="mt-0.5" error={error.cause} />
							</div>
						)}
						{stderr && (
							<pre
								className={cx(
									"max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sc-xs",
									error && "mt-2",
								)}
							>
								{stderr}
							</pre>
						)}
					</div>
				)}
				{result?.success && (
					<div className="overflow-x-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
						<table className="w-full text-left text-sc-xs">
							<thead className="text-(--sc-text-muted)">
								<tr className="border-b border-(--sc-divider)">
									{["model", "success", "ttft", "prefill", "decode", "throughput", "cost"].map(key => (
										<th className="px-3 py-2 font-medium" key={key}>
											{t(`benchmark.col.${key}`)}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-(--sc-divider) tabular-nums">
								{result.summary.models.map(report => {
									const succeeded = report.results.filter(item => item.ok).length;
									return (
										<tr key={report.selector} title={report.stats ? undefined : resultError(report)}>
											<td className="px-3 py-2 font-mono text-(--sc-text)">
												{report.model}
												{report.results.some(item => !item.ok) && (
													<ErrorDetail
														className="mt-1 max-w-64 whitespace-pre-wrap"
														error={resultError(report)}
													/>
												)}
											</td>
											<td className="px-3 py-2">{`${succeeded}/${report.results.length}`}</td>
											<td className="px-3 py-2">
												{report.stats ? formatMetric(report.stats.ttftMs.p50, " ms") : "—"}
											</td>
											<td className="px-3 py-2">
												{report.stats ? formatMetric(report.stats.prefillTps.p50, " tok/s") : "—"}
											</td>
											<td className="px-3 py-2">
												{report.stats ? formatMetric(report.stats.generationTps.p50, " tok/s") : "—"}
											</td>
											<td className="px-3 py-2">
												{report.stats ? formatMetric(report.stats.tokensPerSecond.p50, " tok/s") : "—"}
											</td>
											<td className="px-3 py-2">{report.stats ? formatUsd(report.stats.cost) : "—"}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</Modal>
	);
}
