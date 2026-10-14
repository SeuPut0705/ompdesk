/**
 * The notification chime: two short sine notes synthesized with Web Audio,
 * so the app ships no sound file. Plays with each desktop notification when
 * Settings › General › Notification sound is on; the volume row's "Play"
 * button calls `playChime` directly.
 */

import { useUiStore } from "../stores/ui";

/** Each note: frequency (Hz), start offset and length (seconds). */
const NOTES = [
	{ frequency: 880, at: 0, length: 0.22 },
	{ frequency: 1318.5, at: 0.12, length: 0.32 },
] as const;

let context: AudioContext | null = null;

/** Plays the chime at `volume` (0–100); silent where Web Audio is missing. */
export function playChime(volume: number): void {
	if (typeof AudioContext === "undefined" || volume <= 0) return;
	context ??= new AudioContext();
	const audio = context;
	void audio.resume().catch(() => {});
	const peak = (Math.min(volume, 100) / 100) * 0.4;
	const start = audio.currentTime + 0.01;
	for (const note of NOTES) {
		const oscillator = audio.createOscillator();
		const gain = audio.createGain();
		oscillator.type = "sine";
		oscillator.frequency.value = note.frequency;
		gain.gain.setValueAtTime(0.0001, start + note.at);
		gain.gain.exponentialRampToValueAtTime(peak, start + note.at + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
		oscillator.connect(gain).connect(audio.destination);
		oscillator.start(start + note.at);
		oscillator.stop(start + note.at + note.length + 0.02);
	}
}

/** The chime for a shown notification, when the user turned the sound on. */
export function playNotificationSound(): void {
	const { notificationSound, notificationVolume } = useUiStore.getState();
	if (notificationSound) playChime(notificationVolume);
}
