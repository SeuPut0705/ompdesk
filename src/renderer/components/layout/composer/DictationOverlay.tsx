import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { Kbd } from "../../common";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/**
 * Over the composer's text while dictating: "Starting microphone…" until the
 * mic opens, then a live level meter with the take's m:ss and the keys that end
 * it (Enter inserts, Esc discards), then "Transcribing…". The draft below stays
 * as it was; the transcript lands at its caret.
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
			className="omp-dictation absolute inset-x-2 top-2 bottom-0 z-1 flex items-center gap-3 rounded-(--sc-radius-md) bg-(--sc-surface-1) px-3 text-sc-sm text-(--sc-text-secondary)"
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
