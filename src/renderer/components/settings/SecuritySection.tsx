/**
 * Settings › Security: readiness, scan controls, findings by severity with a
 * detail/disposition editor, and recent scans. Turning the security feature
 * on is its own decision, so a scan that would flip it asks first.
 */
import { CheckCircle2, CircleDashed, FileCode2, Play, ScanSearch, ShieldCheck, X, XCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	RpcSecurityDashboardResult,
	RpcSecurityDispositionStatus,
	RpcSecurityFindingInfo,
	RpcSecurityScanResult,
	RpcSecurityTargetInput,
} from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import {
	Badge,
	type BadgeVariant,
	Banner,
	Button,
	ConfirmDialog,
	EmptyState,
	IconButton,
	Input,
	ListRow,
	Select,
	Spinner,
} from "../common";
import { SettingsSection } from "./SettingsLayout";

const ACTIVE_PHASES: Record<string, true> = { queued: true, preparing: true, reviewing: true, publishing: true };
const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
type Severity = (typeof SEVERITIES)[number];
const SEVERITY_BADGE: Record<Severity, BadgeVariant> = {
	critical: "error",
	high: "error",
	medium: "warning",
	low: "success",
	informational: "info",
};
const SEVERITY_FILL: Record<Severity, string> = {
	critical: "bg-(--sc-danger)",
	high: "bg-(--sc-danger)",
	medium: "bg-(--sc-warning)",
	low: "bg-(--sc-success)",
	informational: "bg-(--sc-info)",
};

function formatWhen(value?: string): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const delta = Date.now() - date.getTime();
	if (delta < 60_000) return "<1m";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
	return date.toLocaleDateString();
}

/** i18n suffix of a scan target (`security.scan.*`, `security.target.*`); other stored kinds read as repository. */
function targetLabel(target: { kind: string }): "repository" | "diff" | "workingTree" {
	if (target.kind === "working_tree") return "workingTree";
	if (target.kind === "ref_diff") return "diff";
	return "repository";
}

function findingPath(finding: RpcSecurityFindingInfo): string {
	if (!finding.path) return "—";
	return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

function severityCounts(findings: RpcSecurityFindingInfo[]): Record<Severity, number> {
	const counts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SecuritySection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const [dashboard, setDashboard] = useState<RpcSecurityDashboardResult>();
	const [selectedScan, setSelectedScan] = useState<RpcSecurityScanResult>();
	const [selectedFindingId, setSelectedFindingId] = useState<string>();
	const [target, setTarget] = useState<RpcSecurityTargetInput>({ kind: "working_tree" });
	const [baseRevision, setBaseRevision] = useState("main");
	const [headRevision, setHeadRevision] = useState("HEAD");
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string>();
	const [disposition, setDisposition] = useState<RpcSecurityDispositionStatus>("open");
	const [rationale, setRationale] = useState("");
	const [savingDisposition, setSavingDisposition] = useState(false);
	const [validating, setValidating] = useState(false);
	const [pendingScan, setPendingScan] = useState(false);
	const generation = useRef(0);
	const loadInFlightRef = useRef<Promise<void> | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Changing the task client invalidates the previous task's responses.
	useEffect(() => {
		setDashboard(undefined);
		setSelectedScan(undefined);
		setSelectedFindingId(undefined);
		setError(undefined);
		loadInFlightRef.current = undefined;
		return () => {
			generation.current++;
		};
	}, [tabRpc]);

	const load = useCallback(
		(silent = false): Promise<void> => {
			if (!sidecarReady) {
				setDashboard(undefined);
				setError(t("common.notConnected"));
				setLoading(false);
				return Promise.resolve();
			}
			const version = generation.current;
			const inFlight = loadInFlightRef.current;
			if (inFlight) return inFlight;
			if (!silent) setLoading(true);
			const request = (async () => {
				try {
					const response = await tabRpc.getSecurityDashboard();
					if (version !== generation.current) return;
					if (!response.success) {
						setError(response.error);
						return;
					}
					const next = response.data as RpcSecurityDashboardResult;
					setDashboard(next);
					setSelectedScan(current =>
						current?.scan.id === next.latest?.scan.id ? next.latest : (current ?? next.latest),
					);
					setError(undefined);
				} catch (cause) {
					if (version === generation.current) setError(errorMessage(cause));
				} finally {
					if (version === generation.current) setLoading(false);
				}
			})();
			loadInFlightRef.current = request;
			void request.finally(() => {
				if (loadInFlightRef.current === request) loadInFlightRef.current = undefined;
			});
			return request;
		},
		[sidecarReady, t, tabRpc.getSecurityDashboard],
	);
	const refresh = useCallback(async (): Promise<void> => {
		const inFlight = loadInFlightRef.current;
		if (inFlight) await inFlight;
		await load(true);
	}, [load]);

	useEffect(() => {
		void load();
	}, [load]);

	const activeOperation = dashboard?.operations.find(operation => ACTIVE_PHASES[operation.phase] === true);
	const activeOperationId = activeOperation?.operationId;
	useEffect(() => {
		if (!activeOperationId) return;
		let disposed = false;
		let timer: number | undefined;
		const poll = async () => {
			await load(true);
			if (!disposed) timer = window.setTimeout(() => void poll(), 2_000);
		};
		timer = window.setTimeout(() => void poll(), 2_000);
		return () => {
			disposed = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [activeOperationId, load]);

	const findings = selectedScan?.findings ?? [];
	const emptyState = !dashboard
		? "unavailable"
		: activeOperation
			? "running"
			: !selectedScan
				? "unscanned"
				: selectedScan.scan.status === "completed"
					? "clear"
					: selectedScan.scan.status === "failed"
						? "failed"
						: "incomplete";
	const counts = useMemo(() => severityCounts(findings), [findings]);
	const selectedFinding = findings.find(finding => finding.id === selectedFindingId);
	const scanDisabledReason = !sidecarReady
		? t("common.notConnected")
		: running || activeOperation
			? t("security.scanDisabled.running")
			: !dashboard?.repositoryRoot
				? t("security.scanDisabled.repository")
				: !dashboard.modelReady
					? t("security.scanDisabled.model")
					: undefined;
	const notConnectedTitle = !sidecarReady ? t("common.notConnected") : undefined;
	useEffect(() => {
		if (!selectedFinding) return;
		setDisposition(selectedFinding.disposition);
		setRationale("");
	}, [selectedFinding]);

	const runScan = async () => {
		if (!sidecarReady) return;
		setPendingScan(false);
		setRunning(true);
		setError(undefined);
		try {
			if (!dashboard?.enabled) {
				const enabled = await tabRpc.setSetting("security.enabled", true);
				if (!enabled.success) {
					setError(enabled.error);
					return;
				}
			}
			const scanTarget: RpcSecurityTargetInput =
				target.kind === "ref_diff" ? { kind: "ref_diff", baseRevision, headRevision } : target;
			const response = await tabRpc.securityStart(scanTarget);
			if (!response.success) setError(response.error);
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setRunning(false);
		}
	};

	/**
	 * The feature master switch used to flip as a side effect of a button labelled
	 * "Scan". Turning security on is its own decision — it enables scan planning
	 * and execution beyond this one run — so it is confirmed first.
	 */
	const requestScan = () => {
		if (!sidecarReady) return;
		if (dashboard?.enabled) {
			void runScan();
			return;
		}
		setPendingScan(true);
	};

	const pickScan = async (scanId: string) => {
		if (!sidecarReady) return;
		const response = await tabRpc.getSecurityScan(scanId);
		if (!response.success) {
			setError(response.error);
			return;
		}
		setSelectedScan(response.data as RpcSecurityScanResult);
		setSelectedFindingId(undefined);
	};

	const saveDisposition = async () => {
		if (!sidecarReady || !selectedFinding) return;
		setSavingDisposition(true);
		try {
			const response = await tabRpc.securitySetDisposition(
				selectedFinding.scanId,
				selectedFinding.id,
				disposition,
				rationale,
			);
			if (response.success) {
				const updated = response.data as RpcSecurityFindingInfo;
				setSelectedScan(current =>
					current
						? { ...current, findings: current.findings.map(item => (item.id === updated.id ? updated : item)) }
						: current,
				);
				setRationale("");
			} else setError(response.error);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSavingDisposition(false);
		}
	};

	const validateFinding = async () => {
		if (!sidecarReady || !selectedFinding) return;
		setValidating(true);
		setError(undefined);
		try {
			const response = await tabRpc.securityValidate(selectedFinding.scanId, selectedFinding.id);
			if (!response.success) {
				setError(response.error);
				return;
			}
			// The user asked to re-check one finding, not to leave Settings: the
			// dashboard read back is what reports the new verdict.
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setValidating(false);
		}
	};

	const cancelOperation = async () => {
		if (!sidecarReady || !activeOperationId) return;
		try {
			const response = await tabRpc.securityCancel(activeOperationId);
			if (!response.success) setError(response.error);
			await refresh();
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	let body: ReactNode;
	if (loading && !dashboard) {
		body = (
			<div className="flex justify-center py-16">
				<Spinner />
			</div>
		);
	} else if (!dashboard) {
		body = (
			<div className="py-3">
				<Banner
					actions={
						<Button disabled={!sidecarReady} onClick={() => void load()} size="sm" title={notConnectedTitle}>
							{t("common.retry")}
						</Button>
					}
					live
					title={t("security.empty.unavailable")}
					variant="danger"
				>
					{error}
				</Banner>
			</div>
		);
	} else {
		body = (
			<div className="flex flex-col gap-3 py-3">
				<div className="flex flex-wrap items-center gap-2">
					<Badge dot variant={dashboard.enabled ? "success" : "warning"}>
						{dashboard.enabled ? t("security.ready.enabled") : t("security.ready.disabled")}
					</Badge>
					<Badge dot variant={dashboard.modelReady ? "success" : "warning"}>
						{dashboard.modelReady
							? t("security.ready.model", { model: dashboard.modelLabel ?? "—" })
							: t("security.ready.noModel")}
					</Badge>
					<Badge dot variant={dashboard.repositoryRoot ? "success" : "warning"}>
						{dashboard.repositoryRoot ? t("security.ready.repository") : t("security.ready.noRepository")}
					</Badge>
					<span className="ml-auto text-sc-xs text-(--sc-text-muted)">
						{t("security.lastScan", {
							time: formatWhen(dashboard.scans[0]?.completedAt ?? dashboard.scans[0]?.createdAt),
						})}
					</span>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Select
						aria-label={t("security.scan.scope")}
						controlSize="sm"
						onChange={event => {
							const kind = event.target.value;
							if (kind === "ref_diff") setTarget({ kind: "ref_diff", baseRevision, headRevision });
							else if (kind === "repository") setTarget({ kind: "repository" });
							else setTarget({ kind: "working_tree" });
						}}
						options={[
							{ value: "working_tree", label: t("security.target.workingTree") },
							{ value: "repository", label: t("security.target.repository") },
							{ value: "ref_diff", label: t("security.target.diff") },
						]}
						value={target.kind}
					/>
					<Button
						disabled={!sidecarReady || !dashboard.repositoryRoot || !dashboard.modelReady || !!activeOperation}
						icon={<Play />}
						loading={running}
						onClick={requestScan}
						size="sm"
						title={scanDisabledReason}
						variant="primary"
					>
						{t(`security.scan.${targetLabel(target)}`)}
					</Button>
					{scanDisabledReason && (
						<span className="text-sc-xs text-(--sc-text-muted)" role="status">
							{scanDisabledReason}
						</span>
					)}
				</div>

				{target.kind === "ref_diff" && (
					<div className="security-revision-grid grid gap-2">
						<Input
							label={t("security.target.base")}
							mono
							onChange={event => setBaseRevision(event.target.value)}
							value={baseRevision}
						/>
						<Input
							label={t("security.target.head")}
							mono
							onChange={event => setHeadRevision(event.target.value)}
							value={headRevision}
						/>
					</div>
				)}

				<div className="flex items-center gap-3 text-sc-sm">
					<span className="font-medium text-(--sc-text)">{t("security.repository")}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-(--sc-text-muted)">
						{dashboard.repositoryRoot ?? "—"}
					</span>
					<span className="font-mono text-sc-xs text-(--sc-text-muted)">{dashboard.revision ?? "—"}</span>
				</div>

				{error && (
					<Banner live variant="danger">
						{error}
					</Banner>
				)}

				<div className="security-master-detail overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
					<section aria-label={t("security.currentRisk")} className="security-findings-pane min-w-0">
						<div className="border-b border-(--sc-divider) px-3 py-3">
							<div className="mb-2 flex items-center justify-between gap-3">
								<h3 className="text-sc-md font-semibold text-(--sc-text)">{t("security.currentRisk")}</h3>
								{selectedScan && (
									<span className="text-sc-xs text-(--sc-text-muted)">{selectedScan.scan.producer}</span>
								)}
							</div>
							<div
								aria-hidden
								className="flex h-1.5 overflow-hidden rounded-(--sc-radius-full) bg-(--sc-surface-3)"
							>
								{SEVERITIES.map(severity => {
									const count = counts[severity];
									if (count === 0 || findings.length === 0) return null;
									return (
										<span
											className={SEVERITY_FILL[severity]}
											key={severity}
											style={{ width: `${(count / findings.length) * 100}%` }}
										/>
									);
								})}
							</div>
							<div className="mt-2 flex flex-wrap gap-1.5">
								{SEVERITIES.filter(severity => counts[severity] > 0).map(severity => (
									<Badge key={severity} variant={SEVERITY_BADGE[severity]}>
										{t(`security.severity.${severity}`)} {counts[severity]}
									</Badge>
								))}
							</div>
						</div>
						{findings.length === 0 ? (
							<div role="status">
								<EmptyState
									description={t(
										emptyState === "clear" ? "security.empty.description" : "security.empty.notVerified",
									)}
									icon={
										emptyState === "clear" ? (
											<ShieldCheck className="text-(--sc-success)" />
										) : emptyState === "running" ? (
											<Spinner />
										) : (
											<ScanSearch />
										)
									}
									title={t(emptyState === "clear" ? "security.empty.title" : `security.empty.${emptyState}`)}
								/>
							</div>
						) : (
							<div className="max-h-80 overflow-y-auto p-1.5">
								{SEVERITIES.map(severity => {
									const group = findings.filter(item => item.severity === severity);
									if (group.length === 0) return null;
									return (
										<div className="mb-3" key={severity}>
											<div className="mb-1 px-2.5 text-sc-xs font-semibold text-(--sc-text-secondary)">
												{t(`security.severity.${severity}`)} ({group.length})
											</div>
											{group.map(finding => (
												<ListRow
													description={<span className="font-mono">{findingPath(finding)}</span>}
													key={finding.id}
													leading={
														<span
															aria-hidden
															className={cx(
																"size-1.5 rounded-(--sc-radius-full)",
																SEVERITY_FILL[severity],
															)}
														/>
													}
													meta={[finding.confidence, finding.validation, finding.disposition].join(" · ")}
													onClick={() => setSelectedFindingId(finding.id)}
													selected={selectedFindingId === finding.id}
													title={finding.title}
													titleText={finding.title}
												/>
											))}
										</div>
									);
								})}
							</div>
						)}
					</section>

					<aside className="security-insights-pane min-w-0 p-3">
						<h3 className="text-sc-sm font-semibold text-(--sc-text)">{t("security.why")}</h3>
						<p className="mt-1.5 text-sc-sm text-(--sc-text-muted)">
							{selectedFinding?.summary ?? t("security.whyDefault")}
						</p>
						<h3 className="mt-5 text-sc-sm font-semibold text-(--sc-text)">{t("security.suggestion")}</h3>
						<p className="mt-1.5 text-sc-sm text-(--sc-text-muted)">
							{selectedFinding?.remediation ?? t("security.suggestionDefault")}
						</p>
						<div className="mt-5 border-t border-(--sc-divider) pt-3">
							<h3 className="mb-2 text-sc-sm font-semibold text-(--sc-text)">{t("security.recentScans")}</h3>
							{dashboard.scans.slice(0, 5).map(scan => (
								<ListRow
									disabled={!sidecarReady}
									key={scan.id}
									leading={
										scan.status === "completed" ? (
											<CheckCircle2 className="text-(--sc-success)" />
										) : scan.status === "failed" ? (
											<XCircle className="text-(--sc-danger)" />
										) : (
											<CircleDashed className="text-(--sc-warning)" />
										)
									}
									meta={`${scan.findingCount} · ${formatWhen(scan.completedAt ?? scan.createdAt)}`}
									onClick={() => void pickScan(scan.id)}
									title={t(`security.target.${targetLabel(scan.target)}`)}
								/>
							))}
							{dashboard.scans.length === 0 && (
								<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("security.noScans")}</p>
							)}
						</div>
						{activeOperation && (
							<Banner
								actions={
									<Button
										disabled={!sidecarReady}
										onClick={() => void cancelOperation()}
										size="sm"
										title={notConnectedTitle}
										variant="ghost"
									>
										{t("security.cancel")}
									</Button>
								}
								className="mt-4"
								live
								variant="warning"
							>
								<span className="flex items-center gap-2">
									<Spinner inheritColor size="sm" />
									{t(`security.phase.${activeOperation.phase}`)}
								</span>
							</Banner>
						)}
					</aside>
				</div>

				{selectedFinding && (
					<section
						aria-label={selectedFinding.title}
						className="security-finding-detail relative grid gap-4 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-3"
					>
						<IconButton
							className="absolute top-2 right-2"
							icon={<X />}
							label={t("common.close")}
							onClick={() => setSelectedFindingId(undefined)}
							size="sm"
						/>
						<div className="min-w-0">
							<div className="mb-2 flex items-center gap-2 pr-8">
								<FileCode2 aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
								<h3 className="truncate text-sc-sm font-semibold text-(--sc-text)">{selectedFinding.title}</h3>
								<Badge variant={SEVERITY_BADGE[selectedFinding.severity]}>
									{t(`security.severity.${selectedFinding.severity}`)}
								</Badge>
							</div>
							<div className="mb-1 font-mono text-sc-xs text-(--sc-text-muted)">
								{findingPath(selectedFinding)}
							</div>
							<pre className="max-h-32 overflow-auto rounded-(--sc-radius-md) bg-(--sc-surface-1) p-2 font-mono text-sc-xs whitespace-pre-wrap text-(--sc-text-secondary)">
								{selectedFinding.evidence[0]?.excerpt ??
									selectedFinding.evidence[0]?.explanation ??
									selectedFinding.summary}
							</pre>
						</div>
						<div className="flex flex-col gap-2 pr-8">
							<Select
								label={t("security.disposition")}
								onChange={event => setDisposition(event.target.value as RpcSecurityDispositionStatus)}
								options={[
									{ value: "open", label: t("security.disposition.open") },
									{ value: "fixed", label: t("security.disposition.fixed") },
									{ value: "false_positive", label: t("security.disposition.falsePositive") },
									{ value: "accepted_risk", label: t("security.disposition.acceptedRisk") },
									{ value: "wont_fix", label: t("security.disposition.wontFix") },
								]}
								value={disposition}
							/>
							{disposition !== "open" && (
								<Input
									label={t("security.rationale")}
									onChange={event => setRationale(event.target.value)}
									value={rationale}
								/>
							)}
							<div className="flex justify-end gap-2">
								<Button
									disabled={!sidecarReady}
									loading={validating}
									onClick={() => void validateFinding()}
									size="sm"
									title={notConnectedTitle}
									variant="ghost"
								>
									{t("security.validate")}
								</Button>
								<Button
									disabled={!sidecarReady || (disposition !== "open" && rationale.trim() === "")}
									loading={savingDisposition}
									onClick={() => void saveDisposition()}
									size="sm"
									title={notConnectedTitle}
								>
									{t("security.saveDisposition")}
								</Button>
							</div>
						</div>
					</section>
				)}
			</div>
		);
	}

	return (
		<SettingsSection description={t("security.subtitle")} title={t("security.title")}>
			{body}
			<ConfirmDialog
				busy={running}
				confirmLabel={t("security.enableScanAction")}
				message={t("security.enableScanBody")}
				onCancel={() => setPendingScan(false)}
				onConfirm={() => void runScan()}
				open={pendingScan}
				title={t("security.enableScanTitle")}
				warning={t("security.enableScanWarning")}
			/>
		</SettingsSection>
	);
}
