/**
 * The voice call's one-row bar in the bot's pane, above the decisions dock and the composer: a live level meter, the
 * phase in words, the last words heard, Mute and End. Mounting it starts the call (`lib/voice-call.ts`) and unmounting
 * it (the tab closes or the pane goes) ends it. A call that cannot go on (no microphone, no dictation model) keeps the
 * bar up with one line saying why until End is pressed; the words carry every state, so nothing here is a spinner.
 * While the language's speech model downloads (`preparing`) the bar names the language and shows how far it got. While
 * an utterance's words have not come back (a model with no running text, such as Whisper, transcribes only after the
 * speech) it says "Transcribing…" and shows no earlier words.
 */
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { languageName } from "../../lib/format";
import { translate, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { METER_BARS } from "../../lib/voice";
import {
	type CallError,
	type CallSnapshot,
	INITIAL_CALL_STATE,
	startVoiceCall,
	type VoiceCall,
} from "../../lib/voice-call";
import { publishCallLevel, useBotCallStore } from "../../stores/bot-call";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, IconButton, LinkButton, ProgressBar } from "../common";

const STT_SETTING_TARGET = "agent:setting-stt.enabled";

const ERROR_MESSAGE: Record<CallError, string> = {
	denied: "voice.fail.denied",
	"no-device": "voice.fail.noDevice",
	"in-use": "voice.fail.inUse",
	"no-model": "botCall.error.noModel",
	failed: "botCall.error.failed",
	busy: "botCall.error.failed",
	empty: "botCall.error.failed",
	speak: "voice.speak.failed",
	recognition: "botCall.error.recognition",
};

/** `finishing`: the call listens on while an utterance's final text is still coming. */
function phaseKey({ phase, muted, language }: CallSnapshot, finishing: boolean): string {
	if (finishing) return "botCall.phase.transcribing";
	switch (phase) {
		case "starting":
			return "botCall.phase.starting";
		case "preparing":
			return language ? "botCall.phase.preparing" : "botCall.phase.preparingAny";
		case "listening":
			return muted ? "botCall.phase.muted" : "botCall.phase.listening";
		case "hearing":
			return "botCall.phase.hearing";
		case "transcribing":
			return "botCall.phase.transcribing";
		case "waiting":
			return "botCall.phase.waiting";
		case "speaking":
			return muted ? "botCall.phase.speakingMuted" : "botCall.phase.speaking";
		case "ended":
			return "botCall.end";
	}
}

const QUIET_LEVELS: readonly number[] = Array.from({ length: METER_BARS }, () => 0);

/** A bar is 4 px quiet and 20 px at full level; the 20 px box is scaled, never resized. */
function meterScale(level: number): number {
	return Number(((4 + level * 16) / 20).toFixed(2));
}

/**
 * `closing`: the pane is already taking the bar away (its height shrinks, `Collapse`), so the call is over now rather
 * than when the bar finally unmounts.
 */
export function BotCallBar({ tabId, closing = false }: { tabId: string; closing?: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const rpcRef = useRef(rpc);
	rpcRef.current = rpc;
	const callRef = useRef<VoiceCall | null>(null);
	const [snapshot, setSnapshot] = useState<CallSnapshot>({
		...INITIAL_CALL_STATE,
		levels: QUIET_LEVELS,
		outputLevel: 0,
	});

	// While the pane takes the bar away (`closing`) the call is over: it ends now, not when the shrinking bar finally
	// unmounts, and a call started again meanwhile runs on this bar.
	useEffect(() => {
		if (closing) return;
		let cancelled = false;
		const call = startVoiceCall({
			tabId,
			send: async (text, { streaming }) => {
				const client = rpcRef.current;
				const response = streaming ? await client.followUp(text) : await client.prompt(text);
				if (!response.success) toastError({ title: translate("input.sendFailed"), error: response });
				return response.success;
			},
			onState: next => {
				if (cancelled) return;
				setSnapshot(next);
				useBotCallStore.getState().setSpeaking(tabId, next.phase === "speaking");
				publishCallLevel(next.phase === "speaking" ? next.outputLevel : 0);
			},
		});
		callRef.current = call;
		return () => {
			cancelled = true;
			callRef.current = null;
			call.end();
			useBotCallStore.getState().setSpeaking(tabId, false);
			publishCallLevel(0);
		};
	}, [tabId, closing]);

	const { phase, muted, heard, partial, error, levels, preparing } = snapshot;
	const language = languageName(snapshot.language) ?? "";
	const ended = phase === "ended";
	const finishing = snapshot.finishing > 0 && (phase === "listening" || phase === "waiting");
	// Earlier words are stale while new ones are spoken or transcribed; only the running text, if any, shows then.
	const said = phase === "hearing" || finishing ? "" : heard;
	// The meter fades out when the call ends instead of vanishing, then leaves the row. While the speech model downloads
	// the mic is not open yet, and the row needs the room for the language and the progress.
	const meter = useOverlayPresence(!ended && phase !== "preparing", "fast");
	const endCall = () => {
		callRef.current?.end();
		useBotCallStore.getState().end(tabId);
	};
	return (
		<div
			className="omp-bot-column shrink-0 pt-2"
			data-bot-call-bar=""
			data-bot-call-phase={phase}
			data-bot-call-transcribing={finishing ? "" : undefined}
		>
			<div className="omp-composer-shell">
				<div
					aria-label={t("botCall.bar")}
					className="flex min-h-9 items-center gap-2.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) py-1 ps-3 pe-1.5 text-sc-sm"
					role="group"
				>
					{meter.mounted ? (
						<span
							aria-hidden
							className={`flex h-5 shrink-0 items-center gap-0.5${meter.closing ? " omp-fade-out" : ""}`}
							data-bot-call-meter=""
						>
							{levels.map((level, index) => (
								// The level already moves every frame: scaleY follows it as it comes, with no transition of its own.
								<span
									className="h-5 w-1 rounded-full bg-(--sc-accent)"
									key={index}
									style={{ transform: `scaleY(${meterScale(level)})` }}
								/>
							))}
						</span>
					) : null}
					{error ? (
						<span
							aria-live="polite"
							className="flex min-w-0 flex-1 items-center gap-2 text-(--sc-danger-on-soft)"
							data-bot-call-error={error}
							role="status"
						>
							<span className="min-w-0 truncate" title={t(ERROR_MESSAGE[error], { language })}>
								{t(ERROR_MESSAGE[error], { language })}
							</span>
							{error === "no-model" ? (
								<LinkButton
									className="shrink-0"
									data-bot-call-settings=""
									onClick={() => useUiStore.getState().openSettings(STT_SETTING_TARGET)}
								>
									{t("voice.fail.openSettings")}
								</LinkButton>
							) : null}
						</span>
					) : (
						<>
							<span
								aria-live="polite"
								className="min-w-0 shrink-[2] truncate font-medium text-(--sc-text)"
								data-bot-call-status=""
								role="status"
							>
								{t(phaseKey(snapshot, finishing), { language })}
							</span>
							{preparing !== null ? (
								<span className="min-w-16 flex-1" data-bot-call-progress={preparing}>
									<ProgressBar
										ariaLabel={t(phaseKey(snapshot, finishing), { language })}
										tone="progress"
										value={preparing / 100}
									/>
								</span>
							) : (
								<span
									className={`min-w-0 flex-1 truncate ${partial ? "italic text-(--sc-text)" : "text-(--sc-text-muted)"}`}
									data-bot-call-heard=""
									data-bot-call-partial={partial ? "" : undefined}
									title={
										partial
											? t("botCall.partial", { text: partial })
											: said
												? t("botCall.heard", { text: said })
												: undefined
									}
								>
									{partial ? `“${partial}…”` : said ? `“${said}”` : null}
								</span>
							)}
						</>
					)}
					{ended ? null : (
						<IconButton
							data-bot-call-mute=""
							icon={muted ? <MicOff /> : <Mic />}
							label={t("botCall.mute")}
							onClick={() => callRef.current?.setMuted(!muted)}
							pressed={muted}
							size="sm"
						/>
					)}
					<Button
						data-bot-call-end=""
						icon={<PhoneOff />}
						onClick={endCall}
						size="sm"
						title={t("botCall.endTitle")}
						variant="danger-soft"
					>
						{t("botCall.end")}
					</Button>
				</div>
			</div>
		</div>
	);
}
