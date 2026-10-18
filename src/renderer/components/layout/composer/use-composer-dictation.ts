/**
 * Mic dictation (stt.enabled): click starts capture, click again (or Enter) stops and transcribes, Esc discards;
 * the transcript inserts at the textarea caret. The send button's "Stop and send" and the stt.submitTrigger
 * setting submit the utterance (TUI parity).
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isImeKeyEvent } from "../../../lib/ime";
import {
	cancelVoiceRecording,
	type DictationFailure,
	evaluateSttSubmitTrigger,
	METER_BARS,
	readSttSubmitTrigger,
	recordAndTranscribe,
	stopVoiceRecording,
} from "../../../lib/voice";
import type { DictationPhase } from "./DictationOverlay";

/** A take that ended in an error: the kind picks the message and next step, `detail` is the raw cause. */
export interface DictationFailureView {
	kind: DictationFailure;
	detail: string;
}

export interface ComposerDictation {
	phase: DictationPhase;
	levels: readonly number[];
	startedAt: number | null;
	/** The last take's error, shown under the field until dismissed or the next take starts. */
	failure: DictationFailureView | null;
	dismissFailure: () => void;
	/** The mic button: start a take, or end the one in flight. */
	toggle: () => void;
	/** "Stop and send": end the take and submit the draft once it is transcribed into it. */
	stopAndSend: () => void;
}

export function useComposerDictation({
	textareaRef,
	placeDraft,
	sendRef,
	mountedRef,
}: {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	/** The send of the latest render: a take transcribed later sends what the composer holds then (pictures, mode, run). */
	sendRef: RefObject<(overrideText?: string) => unknown>;
	mountedRef: RefObject<boolean>;
}): ComposerDictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [levels, setLevels] = useState<readonly number[]>(() => Array(METER_BARS).fill(0));
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [failure, setFailure] = useState<DictationFailureView | null>(null);
	const dismissFailure = useCallback(() => setFailure(null), []);
	/** "Stop and send": submit the draft once the take is transcribed into it. */
	const sendAfterDictationRef = useRef(false);
	/** This composer started the take in flight: only then does its unmount discard it (another pane may be dictating). */
	const ownsTake = useRef(false);
	const recording = phase !== "idle";

	// This composer's in-flight dictation is cancelled (never transcribed) if it unmounts; the
	// recording slot is app-wide, and closing one split pane must not end another pane's take.
	useEffect(
		() => () => {
			if (ownsTake.current) cancelVoiceRecording();
		},
		[],
	);

	const toggle = useCallback(() => {
		if (recording) {
			if (phase === "starting") cancelVoiceRecording();
			else stopVoiceRecording();
			return;
		}
		setFailure(null);
		setPhase("starting");
		ownsTake.current = true;
		sendAfterDictationRef.current = false;
		void recordAndTranscribe({
			onRecording: () => {
				if (!mountedRef.current) return;
				setStartedAt(Date.now());
				setPhase("recording");
			},
			onLevels: next => {
				if (mountedRef.current) setLevels(next);
			},
			onTranscribing: () => {
				if (mountedRef.current) setPhase("transcribing");
			},
		}).then(async result => {
			ownsTake.current = false;
			if (!mountedRef.current) return;
			const sendAfter = sendAfterDictationRef.current;
			sendAfterDictationRef.current = false;
			setPhase("idle");
			setStartedAt(null);
			setLevels(Array(METER_BARS).fill(0));
			if ("error" in result) {
				if (result.error) setFailure({ kind: result.failure ?? "failed", detail: result.error });
				return;
			}
			const utterance = result.text.trim();
			const trigger = await readSttSubmitTrigger();
			const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
			const insert = (
				evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
			).trimEnd();
			if (!mountedRef.current) return;
			if (!insert) {
				// Nothing heard: "Stop and send" still sends what the draft already holds.
				if (sendAfter && textareaRef.current?.value.trim()) sendRef.current();
				return;
			}
			// Read the live DOM value/caret: the user may have typed mid-recording.
			const el = textareaRef.current;
			const current = el?.value ?? "";
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			const before = current.slice(0, start);
			const after = current.slice(end);
			const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
			const suffix = after.length === 0 ? " " : "";
			const insertedText = `${prefix}${insert}${suffix}`;
			const next = `${before}${insertedText}${after}`;
			el?.focus();
			placeDraft(next, start + insertedText.length);
			if (evaluation.submit || sendAfter) sendRef.current(next);
		});
	}, [recording, phase, placeDraft, mountedRef, sendRef, textareaRef]);

	const stopAndSend = useCallback(() => {
		sendAfterDictationRef.current = true;
		stopVoiceRecording();
	}, []);

	// While the mic is open, Enter ends the take (transcribe and insert) and Esc
	// discards it, before any other key handler (the composer's, App's abort).
	useEffect(() => {
		if (phase !== "starting" && phase !== "recording") return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			const finish = event.key === "Enter" && !event.shiftKey && phase === "recording";
			if (event.key !== "Escape" && !finish) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (finish) stopVoiceRecording();
			else cancelVoiceRecording();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [phase]);

	return { phase, levels, startedAt, failure, dismissFailure, toggle, stopAndSend };
}
