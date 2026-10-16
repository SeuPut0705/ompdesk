/**
 * Settings › Updates & about › This computer, after omp's rows: the command-line tools of the connected
 * accounts (main `cli-tools/updater.ts`, contract `shared/cli-update.ts`). One switch (default on), then one
 * row per tool that is installed here: its installed and newest version, how it is updated, the last result or
 * why OMPdesk leaves it alone, and "Update now". OMPdesk only updates what is already installed; the renderer
 * names tools by id and never a command.
 */
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import {
	CLI_AUTO_UPDATE_PREF,
	CLI_TOOL_NAMES,
	type CliToolState,
	type CliUpdateState,
} from "../../../shared/cli-update";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useCliUpdateStore } from "../../stores/cli-update";
import { Badge, Button, InlineNotice } from "../common";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What the tool is doing, or what the last check found; the failure's own reason goes in a notice below. */
export function cliStatusText(t: Translate, tool: CliToolState, state: Pick<CliUpdateState, "scheduled">): string {
	const name = CLI_TOOL_NAMES[tool.id];
	if (tool.skip) return t(`cliUpdate.skip.${tool.skip}`);
	if (tool.phase === "checking") return t("cliUpdate.status.checking");
	if (tool.phase === "updating") return t("cliUpdate.status.updating");
	const last = tool.last;
	if (!last) return state.scheduled ? t("cliUpdate.status.notChecked") : t("cliUpdate.status.manualOnly");
	switch (last.kind) {
		case "current":
			return t("cliUpdate.status.current");
		case "updated":
			return last.from
				? t("cliUpdate.status.updatedFrom", { from: last.from, to: last.to })
				: t("cliUpdate.status.updated", { to: last.to });
		case "deferred":
			return t("cliUpdate.status.deferred", { name, latest: last.latest });
		case "failed":
			return t(`cliUpdate.failure.${last.failure.reason}`, { name });
	}
}

function versionText(t: Translate, tool: CliToolState): string {
	const installed = tool.installed
		? t("cliUpdate.version.installed", { version: tool.installed })
		: t("cliUpdate.version.unknown");
	return tool.latest ? `${installed} · ${t("cliUpdate.version.latest", { version: tool.latest })}` : installed;
}

function CliToolRow({ tool, state }: { tool: CliToolState; state: CliUpdateState }) {
	const t = useT();
	const updateNow = useCliUpdateStore(store => store.updateNow);
	const name = CLI_TOOL_NAMES[tool.id];
	const busy = tool.phase !== "idle";
	const failure = !tool.skip && tool.last?.kind === "failed" ? tool.last.failure : null;
	return (
		<SettingsRow
			className="min-w-0"
			control={
				<Button
					aria-label={t("cliUpdate.nowFor", { name })}
					data-testid={`cli-update-now-${tool.id}`}
					disabled={busy || tool.skip !== null}
					icon={<RefreshCw />}
					onClick={() => void updateNow(tool.id)}
					size="sm"
					variant="secondary"
				>
					{t("cliUpdate.now")}
				</Button>
			}
			id={`setting-cli-tool-${tool.id}`}
			label={name}
			badge={
				<Badge variant="muted">
					{tool.method
						? t("cliUpdate.method", { method: t(`cliUpdate.method.${tool.method}`) })
						: t("cliUpdate.method.none")}
				</Badge>
			}
		>
			<div data-cli-tool={tool.id} data-phase={tool.phase}>
				<p className="text-sc-sm break-words text-(--sc-text-secondary)" data-testid={`cli-version-${tool.id}`}>
					{versionText(t, tool)}
				</p>
				<p className="mt-0.5 text-sc-sm break-words text-(--sc-text-muted)" data-testid={`cli-status-${tool.id}`}>
					{cliStatusText(t, tool, state)}
				</p>
				{tool.path && (
					<p className="mt-0.5 font-mono text-sc-xs break-all text-(--sc-text-muted) select-text">{tool.path}</p>
				)}
				{failure && <InlineNotice detail={failure.detail} title={t("cliUpdate.retryNote")} tone="warning" />}
			</div>
		</SettingsRow>
	);
}

export function CliUpdateRows() {
	const t = useT();
	const state = useCliUpdateStore(store => store.state);
	useEffect(() => {
		void useCliUpdateStore.getState().load();
	}, []);
	return (
		<>
			<SettingsSwitchRow
				checked={state?.enabled ?? true}
				description={t("cliUpdate.autoDesc")}
				disabled={state === null}
				id="setting-gui-cliAutoUpdate"
				label={t("cliUpdate.auto")}
				onCheckedChange={next => void saveGuiPreference(CLI_AUTO_UPDATE_PREF, next, () => {})}
			/>
			{state?.tools.map(tool => (
				<CliToolRow key={tool.id} state={state} tool={tool} />
			))}
			{state && state.tools.length === 0 && (
				<p className="py-2 text-sc-sm text-(--sc-text-muted)" data-testid="cli-update-none">
					{t("cliUpdate.none")}
				</p>
			)}
		</>
	);
}
