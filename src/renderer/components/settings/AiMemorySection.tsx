/**
 * Settings › Memory (ai-memory): the one place memory is configured. ai-memory (src/shared/ai-memory.ts) is shipped
 * inside the app and wired into omp by main; this section shows its state and calls `window.omp.aiMemory`. The switch
 * is not a prefs write: main installs or removes the wiring and the service, and pushes the new state back.
 */

import { Brain, FolderOpen, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AiMemoryPhase } from "../../../shared/ai-memory";
import { aiMemoryStatusText } from "../../lib/ai-memory-text";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { toast, toastError } from "../../stores/toast";
import { Badge, Button, ConfirmDialog, CopyButton, InlineNotice, Spinner } from "../common";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";

type Action = "toggle" | "retry" | "purge" | "console" | "password" | "reveal";

const PRIVACY_KEYS = [
	"aiMemory.privacy.local",
	"aiMemory.privacy.recorded",
	"aiMemory.privacy.secrets",
	"aiMemory.privacy.replies",
	"aiMemory.privacy.ignore",
	"aiMemory.privacy.off",
] as const;

export function AiMemorySection() {
	const t = useT();
	const state = useAiMemoryStore(s => s.state);
	const load = useAiMemoryStore(s => s.load);
	const [busy, setBusy] = useState<Action | null>(null);
	const [confirmPurge, setConfirmPurge] = useState(false);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (action: Action, work: () => Promise<void>, done?: string) => {
		setBusy(action);
		try {
			await work();
			if (done) toast({ variant: "success", message: done });
		} catch (error) {
			toastError({ title: t("aiMemory.actionFailed"), error });
		} finally {
			setBusy(null);
		}
	};

	if (!state) {
		return (
			<SettingsSection id="settings-memory" title={t("aiMemory.title")}>
				<Spinner className="w-full justify-center py-6" label={t("common.loading")} />
			</SettingsSection>
		);
	}

	const starting = state.phase === "starting";
	const unsupported = state.phase === "unsupported";
	const problem = state.phase === "failed" || state.phase === "unreachable";
	const running = state.phase === "ready" || state.phase === "unreachable";
	const stats = state.stats;

	return (
		<>
			<SettingsSection description={t("aiMemory.desc")} id="settings-memory" scope="app" title={t("aiMemory.title")}>
				<SettingsSwitchRow
					checked={state.enabled}
					description={t("aiMemory.switch.desc")}
					disabled={starting || unsupported}
					extra={
						starting ? (
							<Spinner
								label={t("aiMemory.phase.startingStep", {
									step: state.step ? t(`aiMemory.step.${state.step}`) : t("aiMemory.step.stage"),
								})}
								size="sm"
							/>
						) : undefined
					}
					icon={<Brain />}
					id="setting-aiMemory"
					label={t("aiMemory.switch.label")}
					onCheckedChange={checked => void run("toggle", () => window.omp.aiMemory.setEnabled(checked))}
				/>
				<SettingsRow
					control={
						problem ? (
							<Button
								icon={<RefreshCw />}
								loading={busy === "retry"}
								onClick={() => void run("retry", () => window.omp.aiMemory.retry())}
								size="sm"
								variant="secondary"
							>
								{t("aiMemory.retry")}
							</Button>
						) : undefined
					}
					footer={
						state.detail && (problem || unsupported) ? (
							<InlineNotice detail={state.detail} title={t(`aiMemory.phase.${state.phase}`)} tone="danger" />
						) : undefined
					}
					id="setting-aiMemory-status"
					label={t("aiMemory.status")}
				>
					<span
						className="flex flex-wrap items-center gap-2 text-sc-sm text-(--sc-text-secondary)"
						data-ai-memory-status
					>
						<Badge variant={statusVariant(state.phase)}>{t(`aiMemory.phase.${state.phase}`)}</Badge>
						{aiMemoryStatusText(t, state)}
					</span>
				</SettingsRow>
				{state.enabled && !unsupported && (
					<>
						<SettingsRow
							control={
								<span className="flex items-center gap-1">
									<Button
										disabled={!state.dataDir}
										icon={<FolderOpen />}
										loading={busy === "reveal"}
										onClick={() => void run("reveal", () => window.omp.aiMemory.revealData())}
										size="sm"
										variant="secondary"
									>
										{t("aiMemory.reveal")}
									</Button>
									{state.dataDir && <CopyButton label={t("aiMemory.copyPath")} text={state.dataDir} />}
								</span>
							}
							id="setting-aiMemory-data"
							label={t("aiMemory.data")}
						>
							<span
								className="block min-w-0 truncate font-mono text-sc-xs text-(--sc-text-muted)"
								data-ai-memory-dir
								title={state.dataDir ?? ""}
							>
								{state.dataDir ?? t("aiMemory.unknown")}
							</span>
							{stats && (
								<span className="block text-sc-xs text-(--sc-text-muted)" data-ai-memory-stats>
									{t("aiMemory.stats", {
										pages: stats.pages,
										sessions: stats.sessions,
										observations: stats.observations,
										size: formatBytes(stats.diskBytes),
									})}
								</span>
							)}
						</SettingsRow>
						<SettingsRow
							control={
								<Button
									disabled={state.phase !== "ready"}
									loading={busy === "console"}
									onClick={() => void run("console", () => window.omp.aiMemory.openWeb())}
									size="sm"
									variant="secondary"
								>
									{t("aiMemory.openConsole")}
								</Button>
							}
							description={t("aiMemory.console.desc")}
							id="setting-aiMemory-console"
							label={t("aiMemory.console")}
						/>
						<SettingsRow
							control={
								<Button
									disabled={!running}
									icon={<KeyRound />}
									loading={busy === "password"}
									onClick={() =>
										void run(
											"password",
											() => window.omp.aiMemory.copyWebPassword(),
											t("aiMemory.passwordCopied"),
										)
									}
									size="sm"
									variant="secondary"
								>
									{t("aiMemory.copyPassword")}
								</Button>
							}
							description={t("aiMemory.password.desc")}
							id="setting-aiMemory-password"
							label={t("aiMemory.password")}
						/>
					</>
				)}
				<SettingsRow
					control={
						<Button
							disabled={starting || busy !== null}
							icon={<Trash2 />}
							onClick={() => setConfirmPurge(true)}
							size="sm"
							variant="danger"
						>
							{t("aiMemory.purge")}
						</Button>
					}
					description={t("aiMemory.purge.desc")}
					id="setting-aiMemory-purge"
					label={t("aiMemory.purge.label")}
				/>
			</SettingsSection>
			<SettingsSection id="settings-memory-privacy" scope="app" title={t("aiMemory.privacy.title")}>
				<ul
					className="flex list-disc flex-col gap-1.5 pl-5 text-sc-sm text-(--sc-text-secondary)"
					data-ai-memory-privacy
				>
					{PRIVACY_KEYS.map(key => (
						<li key={key}>{t(key)}</li>
					))}
				</ul>
			</SettingsSection>
			<ConfirmDialog
				busy={busy === "purge"}
				confirmLabel={t("aiMemory.purge")}
				message={t("aiMemory.purge.confirm")}
				onCancel={() => setConfirmPurge(false)}
				onConfirm={() => {
					void run("purge", () => window.omp.aiMemory.purge(), t("aiMemory.purged")).then(() =>
						setConfirmPurge(false),
					);
				}}
				open={confirmPurge}
				title={t("aiMemory.purge.title")}
				warning={t("aiMemory.purge.warning")}
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
