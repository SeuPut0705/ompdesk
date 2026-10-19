/**
 * Memory › Overview: the switch, the server's status, the project the page shows, its counts, the last capture, the
 * disk size, the console, the terminal omp and the privacy line. One line a row; every explanation is a tooltip.
 * The switch is not a prefs write: main installs or removes the wiring and the service and pushes the state back.
 */
import { Brain, FolderOpen, GraduationCap, KeyRound, RefreshCw, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type {
	AiMemoryOverview,
	AiMemoryPhase,
	AiMemoryProject,
	AiMemoryProjectRef,
	AiMemoryState,
} from "../../../../shared/ai-memory";
import { AI_MEMORY_LEARN_PREF } from "../../../../shared/ai-memory";
import { formatBytes, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Badge, Button, CopyButton, InlineNotice, Spinner } from "../../common";
import { useMainPreference } from "../GeneralSection";
import { SettingsRow, SettingsSwitchRow } from "../SettingsLayout";
import { projectLabel } from "./MemorySection";
import { useMemoryAction } from "./memory-ui";
import { projectKey, useMemoryRead } from "./use-memory-read";

export function MemoryOverview({
	state,
	project,
	projects,
}: {
	state: AiMemoryState;
	project: AiMemoryProjectRef | null;
	projects: readonly AiMemoryProject[];
}) {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const { run } = useMemoryAction();
	const starting = state.phase === "starting";
	const unsupported = state.phase === "unsupported";
	const [learn, setLearn] = useMainPreference(AI_MEMORY_LEARN_PREF, true);
	const problem = state.phase === "failed" || state.phase === "unreachable";
	const usable = state.enabled && !unsupported;
	const ready = state.phase === "ready";
	const stats = state.stats;
	const overview = useMemoryRead<AiMemoryOverview>(ready && project ? `overview/${projectKey(project)}` : null, () =>
		project ? window.omp.aiMemory.overview(project) : Promise.reject(new Error("no project")),
	);
	const counts =
		overview.data ??
		(stats ? { pages: stats.pages, sessions: stats.sessions, observations: stats.observations } : null);

	const act = async (name: string, work: () => Promise<void>, done?: string) => {
		setBusy(name);
		try {
			await run(name, work, done);
		} finally {
			setBusy(null);
		}
	};

	const data = overview.data;
	const activityTip = data
		? t("memory.overview.last.info", {
				sessions: data.activity7d.sessions,
				observations: data.activity7d.observations,
				pages: data.activity7d.pagesUpdated,
				handoffs: data.openHandoffs,
				stale: data.health.stale,
				duplicates: data.health.duplicates,
				orphans: data.health.orphans,
			})
		: t("memory.overview.last.none");

	return (
		<>
			<SettingsSwitchRow
				checked={state.enabled}
				description={t("memory.overview.switch.info")}
				disabled={starting || unsupported}
				extra={
					starting ? (
						<Spinner
							label={t("memory.phase.startingStep", {
								step: state.step ? t(`memory.step.${state.step}`) : t("memory.step.stage"),
							})}
							size="sm"
						/>
					) : undefined
				}
				icon={<Brain />}
				id="setting-aiMemory"
				label={t("memory.overview.switch")}
				onCheckedChange={checked => void act("toggle", () => window.omp.aiMemory.setEnabled(checked))}
			/>
			{state.enabled && !unsupported && (
				<SettingsSwitchRow
					checked={learn}
					description={t("memory.overview.learn.info")}
					icon={<GraduationCap />}
					id="setting-aiMemory-learn"
					label={t("memory.overview.learn")}
					onCheckedChange={setLearn}
				/>
			)}
			<SettingsRow
				tipOnly
				compactControl
				control={
					<span className="flex min-w-0 items-center gap-2 text-sc-sm text-(--sc-text-secondary)">
						<span className="flex min-w-0 items-center gap-2" data-memory-status>
							<Badge variant={statusVariant(state.phase)}>{t(`memory.phase.${state.phase}`)}</Badge>
							<span className="truncate">{statusDetail(t, state)}</span>
						</span>
						{problem && (
							<Button
								icon={<RefreshCw />}
								loading={busy === "retry"}
								onClick={() => void act("retry", () => window.omp.aiMemory.retry())}
								size="sm"
								variant="secondary"
							>
								{t("memory.overview.retry")}
							</Button>
						)}
					</span>
				}
				footer={
					state.detail && (problem || unsupported) ? (
						<InlineNotice detail={state.detail} title={t(`memory.phase.${state.phase}`)} tone="danger" />
					) : undefined
				}
				id="setting-aiMemory-status"
				label={t("memory.overview.status")}
			/>
			{usable && (
				<>
					<SettingsRow
						tipOnly
						compactControl
						control={
							<span className="truncate text-sc-sm text-(--sc-text-secondary)" data-memory-scope>
								{project ? projectLabel(project) : t("memory.overview.scope.none")}
								{projects.length > 1 ? ` · ${t("memory.overview.projects", { count: projects.length })}` : ""}
							</span>
						}
						description={t("memory.overview.scope.info")}
						id="setting-aiMemory-scope"
						label={t("memory.overview.scope")}
					/>
					{counts && (
						<SettingsRow
							tipOnly
							compactControl
							control={
								<span className="text-sc-sm text-(--sc-text-secondary)" data-memory-counts>
									{t("memory.overview.counts.value", {
										pages: counts.pages,
										sessions: counts.sessions,
										observations: counts.observations,
									})}
								</span>
							}
							id="setting-aiMemory-counts"
							label={t("memory.overview.counts")}
						/>
					)}
					<SettingsRow
						tipOnly
						compactControl
						control={
							<span className="text-sc-sm text-(--sc-text-secondary)" data-memory-last>
								{data?.lastCaptureAt ? formatTimeAgo(data.lastCaptureAt) : t("memory.overview.last.never")}
							</span>
						}
						description={activityTip}
						id="setting-aiMemory-last"
						label={t("memory.overview.last")}
					/>
					<SettingsRow
						tipOnly
						compactControl
						control={
							<span className="text-sc-sm text-(--sc-text-secondary)" data-memory-disk>
								{stats ? formatBytes(stats.diskBytes) : t("memory.overview.unknown")}
							</span>
						}
						id="setting-aiMemory-disk"
						label={t("memory.overview.disk")}
					/>
					<SettingsRow
						tipOnly
						compactControl
						control={
							<span className="flex min-w-0 items-center gap-3">
								<span
									className="max-w-48 truncate font-mono text-sc-xs text-(--sc-text-muted)"
									data-memory-dir
									title={state.dataDir ?? ""}
								>
									{state.dataDir ?? t("memory.overview.unknown")}
								</span>
								<Button
									disabled={!state.dataDir}
									icon={<FolderOpen />}
									loading={busy === "reveal"}
									onClick={() => void act("reveal", () => window.omp.aiMemory.revealData())}
									size="sm"
									variant="secondary"
								>
									{t("memory.overview.reveal")}
								</Button>
								{state.dataDir && <CopyButton label={t("memory.overview.copyPath")} text={state.dataDir} />}
							</span>
						}
						id="setting-aiMemory-data"
						label={t("memory.overview.data")}
					/>
					<SettingsRow
						tipOnly
						compactControl
						control={
							<Button
								disabled={!ready}
								loading={busy === "console"}
								onClick={() => void act("console", () => window.omp.aiMemory.openWeb())}
								size="sm"
								variant="secondary"
							>
								{t("memory.overview.console.open")}
							</Button>
						}
						description={t("memory.overview.console.info")}
						id="setting-aiMemory-console"
						label={t("memory.overview.console")}
					/>
					<SettingsRow
						tipOnly
						compactControl
						control={
							<Button
								disabled={state.phase !== "ready" && state.phase !== "unreachable"}
								icon={<KeyRound />}
								loading={busy === "password"}
								onClick={() =>
									void act(
										"password",
										() => window.omp.aiMemory.copyWebPassword(),
										t("memory.overview.passwordCopied"),
									)
								}
								size="sm"
								variant="secondary"
							>
								{t("memory.overview.password")}
							</Button>
						}
						description={t("memory.overview.password.info")}
						id="setting-aiMemory-password"
						label={t("memory.overview.passwordLabel")}
					/>
				</>
			)}
			{!unsupported && (state.enabled || state.wiring.terminal) && (
				<SettingsRow
					compactControl
					control={
						<span className="flex min-w-0 items-center gap-2">
							{state.wiring.terminal && (
								<span data-memory-terminal>
									<Badge variant="success">{t("memory.overview.terminal.connected")}</Badge>
								</span>
							)}
							<Button
								disabled={starting || busy !== null}
								icon={<SquareTerminal />}
								loading={busy === "terminal"}
								onClick={() =>
									void act(
										"terminal",
										() => window.omp.aiMemory.setTerminal(!state.wiring.terminal),
										t(
											state.wiring.terminal
												? "memory.overview.terminal.removed"
												: "memory.overview.terminal.done",
										),
									)
								}
								size="sm"
								variant="secondary"
							>
								{t(
									state.wiring.terminal
										? "memory.overview.terminal.remove"
										: "memory.overview.terminal.connect",
								)}
							</Button>
						</span>
					}
					description={t("memory.overview.terminal.info")}
					id="setting-aiMemory-terminal"
					label={t("memory.overview.terminal")}
					tipOnly
				/>
			)}
			<SettingsRow
				tipOnly
				compactControl
				control={
					<span className="text-sc-sm text-(--sc-text-secondary)" data-memory-privacy>
						{t("memory.overview.privacy.line")}
					</span>
				}
				description={t("memory.overview.privacy.info")}
				id="settings-memory-privacy"
				label={t("memory.overview.privacy")}
			/>
		</>
	);
}

function statusVariant(phase: AiMemoryPhase) {
	if (phase === "ready") return "success";
	if (phase === "failed") return "error";
	if (phase === "unreachable") return "warning";
	return "muted";
}

/** What follows the badge: the step while starting, else version and where the program comes from. */
function statusDetail(t: ReturnType<typeof useT>, state: AiMemoryState): string {
	if (state.phase === "starting" && state.step)
		return t("memory.phase.startingStep", { step: t(`memory.step.${state.step}`) });
	const parts: string[] = [];
	if (state.version) parts.push(`v${state.version}`);
	if (state.version && state.phase !== "off" && state.phase !== "unsupported")
		parts.push(t(`memory.source.${state.source}`));
	return parts.join(" · ");
}
