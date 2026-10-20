/**
 * What the composer's one action button is: Send and Stop share a single slot, so nothing waits beside Send for a
 * turn to start. First match wins:
 *
 *   dictation recording        → `dictation` (stop the take and send it)
 *   editing a queued message   → `save` (a check)
 *   a turn runs, empty draft   → `stop` (■, the same Stop as Esc)
 *   phone dictation, no draft  → `mic`
 *   otherwise                  → `send` (disabled while there is nothing to send; while a turn runs it steers or
 *                                queues)
 *
 * While a turn runs, every state but `stop` carries `stopHint`: a long press or right click on the button still stops
 * the turn and keeps the draft (touch has no Esc).
 */

export type SendSlotState = "dictation" | "save" | "stop" | "mic" | "send";

export interface SendSlotFacts {
	/** A dictation take is recording. */
	recording: boolean;
	editingQueued: boolean;
	/** Something Stop ends: the run, or a prompt not yet sent. */
	stoppable: boolean;
	/** The draft holds text or a picture. */
	hasDraft: boolean;
	/** The phone offers dictation in this slot (stock `stt.enabled`, no take running). */
	micOffered: boolean;
}

export interface SendSlot {
	state: SendSlotState;
	/** A turn runs and the button is not Stop: its long press / right click offers Stop, and a small ■ on it says so. */
	stopHint: boolean;
}

export function sendSlot({ recording, editingQueued, stoppable, hasDraft, micOffered }: SendSlotFacts): SendSlot {
	const state: SendSlotState = recording
		? "dictation"
		: editingQueued
			? "save"
			: stoppable && !hasDraft
				? "stop"
				: micOffered && !hasDraft
					? "mic"
					: "send";
	return { state, stopHint: stoppable && state !== "stop" };
}
