/**
 * Settings › Updates & about › This computer › Disk: what OMPdesk's disk care (main `src/main/disk/`) measured and
 * what its last run freed, with a quiet "Clean up". The breakdown and the run's action totals sit behind the row's
 * (i). Paints the last known state at the first frame (`lib/last-read.ts`) and follows the push; a paired web page
 * shows its computer's state, because the channels pass.
 */
import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import {
	DISK_CARE_ARTIFACT_IDLE_DAYS,
	DISK_CARE_REMOVE_IDLE_DAYS,
	type DiskCareState,
} from "../../../shared/disk-care";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { lastRead, rememberRead } from "../../lib/last-read";
import { useTimeAgo } from "../../lib/now-tick";
import { toastError } from "../../stores/toast";
import { Button } from "../common";
import { SettingsRow } from "./SettingsLayout";

const READ_KEY = "disk-care";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** `ago`: when the last run ended, kept current by the row. */
function valueLine(t: Translate, state: DiskCareState | null, ago: string): string {
	if (!state?.usage) return state?.running ? t("diskCare.measuring") : t("diskCare.neverRun");
	const total = t("diskCare.total", { size: formatBytes(state.usage.total) });
	const run = state.lastRun;
	if (!run) return `${total} · ${t("diskCare.neverRun")}`;
	return `${total} · ${t("diskCare.freed", { size: formatBytes(run.freedBytes), ago })}`;
}

function tooltip(t: Translate, state: DiskCareState | null): string {
	const lines = [
		t("diskCare.info", { artifactDays: DISK_CARE_ARTIFACT_IDLE_DAYS, removeDays: DISK_CARE_REMOVE_IDLE_DAYS }),
	];
	if (state && !state.automatic) lines.push(t("diskCare.manualOnly"));
	if (state?.usage)
		for (const part of state.usage.parts) lines.push(`${t(`diskCare.part.${part.id}`)}: ${formatBytes(part.bytes)}`);
	const run = state?.lastRun;
	if (run) {
		for (const action of run.actions)
			lines.push(t(`diskCare.action.${action.kind}`, { count: action.count, size: formatBytes(action.bytes) }));
		if (run.kept > 0) lines.push(t("diskCare.kept", { count: run.kept }));
		if (run.failed > 0) lines.push(t("diskCare.failed", { count: run.failed }));
	}
	return lines.join("\n");
}

export function DiskCareRow() {
	const t = useT();
	const [state, setState] = useState<DiskCareState | null>(() => lastRead<DiskCareState>(undefined, READ_KEY) ?? null);
	const [starting, setStarting] = useState(false);
	const lastRunAgo = useTimeAgo(state?.lastRun?.endedAt);

	useEffect(() => {
		let live = true;
		const apply = (next: DiskCareState) => {
			if (!live) return;
			setState(next);
			rememberRead(undefined, READ_KEY, next);
		};
		const unsubscribe = window.omp.diskCare.onState(apply);
		window.omp.diskCare
			.getState()
			.then(apply)
			.catch(() => {
				// The row keeps its last known state; the next open reads again.
			});
		return () => {
			live = false;
			unsubscribe();
		};
	}, []);

	const running = starting || state?.running === true;
	const clean = async () => {
		setStarting(true);
		try {
			const next = await window.omp.diskCare.run();
			setState(next);
			rememberRead(undefined, READ_KEY, next);
		} catch (error) {
			toastError({ title: t("diskCare.cleanFailed"), error });
		} finally {
			setStarting(false);
		}
	};

	return (
		<SettingsRow
			compactControl
			control={
				<Button
					data-testid="disk-care-clean"
					disabled={running}
					loading={running}
					onClick={() => void clean()}
					size="sm"
					variant="ghost"
				>
					{t("diskCare.clean")}
				</Button>
			}
			description={tooltip(t, state)}
			icon={<HardDrive />}
			id="setting-disk-care"
			label={t("diskCare.label")}
			tipOnly
		>
			<p className="text-sc-sm break-words text-(--sc-text-secondary)" data-testid="disk-care-status">
				{valueLine(t, state, lastRunAgo)}
			</p>
		</SettingsRow>
	);
}
