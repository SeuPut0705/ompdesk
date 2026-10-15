/**
 * Settings › Updates & about › This computer, first rows: omp keeps itself
 * current (main `omp-updater.ts`). One switch (default on), an "Update now"
 * button, what main last learned from npm, and, after a failed attempt, why
 * and that the next check retries. OMPdesk's own update stays manual (the
 * section above).
 */
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { OMP_AUTO_UPDATE_PREF, type OmpUpdateFailure, type OmpUpdateState } from "../../../shared/omp-update";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { Button, InlineNotice } from "../common";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function statusText(t: Translate, state: OmpUpdateState): string {
	if (state.phase === "checking") return t("ompUpdate.status.checking");
	if (state.phase === "updating") return t("ompUpdate.status.updating");
	if (!state.scheduled) return t("ompUpdate.status.manualOnly");
	if (state.installed === null || state.latest === null) return t("ompUpdate.status.notChecked");
	return state.latest === state.installed
		? t("ompUpdate.status.current", { version: state.installed })
		: t("ompUpdate.status.available", { version: state.installed, latest: state.latest });
}

function failureTitle(t: Translate, failure: OmpUpdateFailure, state: OmpUpdateState): string {
	return t(`ompUpdate.failure.${failure.reason}`, { latest: state.latest ?? "" });
}

export function OmpUpdateRows() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	const updateNow = useOmpUpdateStore(store => store.updateNow);
	useEffect(() => {
		useOmpUpdateStore.getState().ensureLoaded();
	}, []);
	const busy = state?.phase !== undefined && state.phase !== "idle";
	return (
		<>
			<SettingsSwitchRow
				checked={state?.enabled ?? true}
				description={t("ompUpdate.autoDesc")}
				disabled={state === null}
				id="setting-gui-ompAutoUpdate"
				label={t("ompUpdate.auto")}
				onCheckedChange={next => void saveGuiPreference(OMP_AUTO_UPDATE_PREF, next, () => {})}
			/>
			<SettingsRow
				control={
					<Button
						data-testid="omp-update-now"
						disabled={state === null || busy}
						icon={<RefreshCw />}
						onClick={() => void updateNow()}
						size="sm"
						variant="secondary"
					>
						{t("ompUpdate.now")}
					</Button>
				}
				id="setting-omp-update-now"
				label={t("ompUpdate.nowLabel")}
			>
				<p className="text-sc-sm break-words text-(--sc-text-secondary)" data-testid="omp-update-status">
					{state ? statusText(t, state) : t("ompUpdate.status.notChecked")}
				</p>
				{state?.failure && (
					<InlineNotice
						detail={state.failure.detail}
						title={`${failureTitle(t, state.failure, state)} ${t("ompUpdate.retryNote")}`}
						tone="warning"
					/>
				)}
			</SettingsRow>
		</>
	);
}
