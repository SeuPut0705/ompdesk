/**
 * Settings › Updates & about › This computer: one "Keep tools up to date" switch (default on) for omp (main
 * `omp-updater.ts`), the tool CLIs and extensions (their rows follow below). omp's own "Update now" and what main
 * last learned from npm sit on omp's machine-setup row (`OmpUpdateNowButton`, `OmpUpdateStatus`): one row for omp,
 * not two. OMPdesk's own update stays manual (the section above).
 */
import { RefreshCcw, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { TOOLS_AUTO_UPDATE_PREF } from "../../../shared/desktop-prefs";
import type { OmpUpdateFailure, OmpUpdateState } from "../../../shared/omp-update";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useOmpUpdateStore } from "../../stores/omp-update";
import { IconButton, InlineNotice } from "../common";
import { SettingsSwitchRow } from "./SettingsLayout";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What is going on or newer; nothing while omp is current, unchecked or left to the person (the switch says so). */
function statusText(t: Translate, state: OmpUpdateState): string | null {
	if (state.phase === "checking") return t("ompUpdate.status.checking");
	if (state.phase === "updating") return t("ompUpdate.status.updating");
	if (state.installed === null || state.latest === null || state.latest === state.installed) return null;
	return t("ompUpdate.status.available", { version: state.installed, latest: state.latest });
}

function failureTitle(t: Translate, failure: OmpUpdateFailure, state: OmpUpdateState): string {
	return t(`ompUpdate.failure.${failure.reason}`, { latest: state.latest ?? "" });
}

/** Why the last omp update attempt failed, and that the next check retries; nothing while the last attempt did not fail. */
export function OmpUpdateFailureNotice({ state }: { state: OmpUpdateState }) {
	const t = useT();
	if (!state.failure) return null;
	return (
		<InlineNotice
			detail={state.failure.detail}
			title={`${failureTitle(t, state.failure, state)} ${t("ompUpdate.retryNote")}`}
			tone="warning"
		/>
	);
}

/** omp's "Update now", in the action slot of its machine-setup row. */
export function OmpUpdateNowButton() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	const updateNow = useOmpUpdateStore(store => store.updateNow);
	const busy = state?.phase !== undefined && state.phase !== "idle";
	return (
		<IconButton
			data-testid="omp-update-now"
			disabled={state === null || busy}
			icon={<RefreshCw />}
			label={t("ompUpdate.now")}
			loading={busy}
			onClick={() => void updateNow()}
			size="sm"
			variant="secondary"
		/>
	);
}

/** Under omp's machine-setup row: a check or update under way, a newer version, or the last failure. */
export function OmpUpdateStatus() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	if (!state) return null;
	const text = statusText(t, state);
	return (
		<>
			{text && (
				<p className="ps-6 text-sc-xs break-words text-(--sc-text-muted)" data-testid="omp-update-status">
					{text}
				</p>
			)}
			<OmpUpdateFailureNotice state={state} />
		</>
	);
}

export function OmpUpdateRows() {
	const t = useT();
	const state = useOmpUpdateStore(store => store.state);
	useEffect(() => {
		useOmpUpdateStore.getState().ensureLoaded();
	}, []);
	return (
		<SettingsSwitchRow
			icon={<RefreshCcw />}
			checked={state?.enabled ?? true}
			description={t("toolsUpdate.autoDesc")}
			tipOnly
			disabled={state === null}
			id="setting-gui-toolsAutoUpdate"
			label={t("toolsUpdate.auto")}
			onCheckedChange={next => void saveGuiPreference(TOOLS_AUTO_UPDATE_PREF, next, () => {})}
		/>
	);
}
