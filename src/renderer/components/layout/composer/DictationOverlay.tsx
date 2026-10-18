import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useUiStore } from "../../../stores/ui";
import { Button, InlineNotice, Kbd } from "../../common";
import type { DictationFailureView } from "./use-composer-dictation";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/**
 * A slim bar between the field and the toolbar while dictating: "Starting microphone…" until the mic opens, then a
 * live level meter with the take's m:ss and the keys that end it (Enter inserts, Esc discards), then
 * "Transcribing…". It never covers the field: the draft stays readable and editable, and the transcript lands at
 * its caret.
 */
export function DictationOverlay({
	phase,
	levels,
	startedAt,
}: {
	phase: Exclude<DictationPhase, "idle">;
	levels: readonly number[];
	startedAt: number | null;
}) {
	const t = useT();
	const now = useNowTick(phase === "recording");
	const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return (
		<div
			className="omp-dictation flex min-h-7 items-center gap-3 px-4 pb-1 text-sc-sm text-(--sc-text-secondary)"
			data-dictation={phase}
			role="status"
		>
			{phase === "recording" ? (
				<>
					<span aria-hidden className="flex h-5 items-center gap-0.5">
						{levels.map((level, index) => (
							<span
								className="w-1 rounded-full bg-(--sc-danger) motion-safe:transition-[height] duration-(--sc-duration-fast)"
								key={index}
								style={{ height: `${Math.round(4 + level * 16)}px` }}
							/>
						))}
					</span>
					<span className="tabular-nums text-(--sc-text)">
						{t("voice.dictation.listening")} · {clock}
					</span>
					<span className="ms-auto flex items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
						<Kbd shortcut="Enter" />
						{t("voice.dictation.insert")}
						<Kbd shortcut="Esc" />
						{t("voice.dictation.discard")}
					</span>
				</>
			) : (
				<span className="omp-pulse-dot">
					{t(phase === "starting" ? "voice.dictation.starting" : "voice.dictation.transcribing")}
				</span>
			)}
		</div>
	);
}

/**
 * A take that failed: one sentence saying what to do (the browser's or the sidecar's text is only the details
 * behind a toggle), plus Settings where Settings is the fix. The OS's own microphone privacy page cannot be opened
 * from here (the host opens web links and mail drafts only), so a blocked microphone says where to go.
 */
export function DictationFailureNotice({
	failure,
	onDismiss,
}: {
	failure: DictationFailureView;
	onDismiss: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const hasDetail = failure.kind !== "busy" && failure.kind !== "empty" && failure.detail !== "";
	return (
		<div className="px-3 pb-1" data-dictation-failure={failure.kind}>
			<InlineNotice
				action={
					<>
						{failure.kind === "no-model" && (
							<Button
								onClick={() => {
									onDismiss();
									useUiStore.getState().openSettings("models:roles");
								}}
								size="sm"
								variant="secondary"
							>
								{t("voice.fail.openSettings")}
							</Button>
						)}
						{hasDetail && (
							<Button aria-expanded={open} onClick={() => setOpen(value => !value)} size="sm" variant="ghost">
								{t("voice.fail.details")}
							</Button>
						)}
						<Button onClick={onDismiss} size="sm" variant="ghost">
							{t("voice.fail.dismiss")}
						</Button>
					</>
				}
				className="py-1"
				detail={open && hasDetail ? failure.detail : undefined}
				live
				title={t(FAILURE_MESSAGE[failure.kind])}
				tone="danger"
			/>
		</div>
	);
}

const FAILURE_MESSAGE = {
	denied: "voice.fail.denied",
	"no-device": "voice.fail.noDevice",
	"in-use": "voice.fail.inUse",
	busy: "voice.mic.busy",
	empty: "voice.mic.empty",
	"no-model": "voice.fail.noModel",
	failed: "voice.fail.failed",
} as const;
