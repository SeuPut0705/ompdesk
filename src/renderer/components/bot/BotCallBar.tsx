/**
 * The voice call's one-row bar in the bot's pane, above the decisions dock and the composer: a live level meter, the
 * phase in words, the last words heard, Mute and End. Mounting it starts the call (`lib/voice-call.ts`) and unmounting
 * it (the tab closes or the pane goes) ends it. A call that cannot go on (no microphone, no dictation model) keeps the
 * bar up with one line saying why until End is pressed; the words carry every state, so nothing here is a spinner.
 */
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { useBotCallStore } from "../../stores/bot-call";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, IconButton, LinkButton } from "../common";

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
};

function phaseKey({ phase, muted }: CallSnapshot): string {
	switch (phase) {
		case "starting":
			return "botCall.phase.starting";
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

export function BotCallBar({ tabId }: { tabId: string }) {
	const t = useT();
	const rpc = useTabRpc();
	const rpcRef = useRef(rpc);
	rpcRef.current = rpc;
	const callRef = useRef<VoiceCall | null>(null);
	const [snapshot, setSnapshot] = useState<CallSnapshot>({ ...INITIAL_CALL_STATE, levels: QUIET_LEVELS });

	useEffect(() => {
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
				if (!cancelled) setSnapshot(next);
			},
		});
		callRef.current = call;
		return () => {
			cancelled = true;
			callRef.current = null;
			call.end();
		};
	}, [tabId]);

	const { phase, muted, heard, partial, error, levels } = snapshot;
	const ended = phase === "ended";
	const endCall = () => {
		callRef.current?.end();
		useBotCallStore.getState().end(tabId);
	};
	return (
		<div className="omp-bot-column shrink-0 pt-2" data-bot-call-bar="" data-bot-call-phase={phase}>
			<div className="omp-composer-shell">
				<div
					aria-label={t("botCall.bar")}
					className="flex min-h-9 items-center gap-2.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) py-1 ps-3 pe-1.5 text-sc-sm"
					role="group"
				>
					{ended ? null : (
						<span aria-hidden className="flex h-5 shrink-0 items-center gap-0.5" data-bot-call-meter="">
							{levels.map((level, index) => (
								<span
									className="w-1 rounded-full bg-(--sc-accent) motion-safe:transition-[height] duration-(--sc-duration-fast)"
									key={index}
									style={{ height: `${Math.round(4 + level * 16)}px` }}
								/>
							))}
						</span>
					)}
					{error ? (
						<span
							aria-live="polite"
							className="flex min-w-0 flex-1 items-center gap-2 text-(--sc-danger-on-soft)"
							data-bot-call-error={error}
							role="status"
						>
							<span className="min-w-0 truncate" title={t(ERROR_MESSAGE[error])}>
								{t(ERROR_MESSAGE[error])}
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
								{t(phaseKey(snapshot))}
							</span>
							<span
								className={`min-w-0 flex-1 truncate ${partial ? "italic text-(--sc-text)" : "text-(--sc-text-muted)"}`}
								data-bot-call-heard=""
								data-bot-call-partial={partial ? "" : undefined}
								title={
									partial
										? t("botCall.partial", { text: partial })
										: heard
											? t("botCall.heard", { text: heard })
											: undefined
								}
							>
								{partial ? `“${partial}…”` : heard ? `“${heard}”` : null}
							</span>
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
