/**
 * The desktop slot: one omp session at a time drives the computer's desktop (input, focus, the
 * observe → act → verify span). Stock lacks this across sessions: its native layer only refuses an input
 * while another desktop operation owns input/focus control ("no input was sent"), it neither queues nor spans
 * a session's observe → act → verify sequence, and each omp process has its own ComputerSupervisor. So main owns
 * one slot per computer and the bridge (desktop-slot.ts) asks it through frames; hosted (remote) tabs use their
 * host's own slot, since the host's main owns that desktop.
 *
 * No omp imports: shared by the bridge, main and the renderer.
 *
 * Bridge → main frames (`emit`; main adds the tab):
 *   { type: "desktop_slot_acquire", requestId }   an acting run wants the slot (main replies by calling `desktop_slot.grant`)
 *   { type: "desktop_slot_touch" }                 progress by the holder (a run started or ended): resets the lease
 *   { type: "desktop_slot_release", reason }       the holder lets go (no revoke needed: the bridge already did it)
 * Main → bridge commands (`modes`-style bridge methods, awaited):
 *   desktop_slot.grant  { requestId }   resolves the waiting acting run
 *   desktop_slot.revoke { reason }      abort the in-flight input run, await stock `ComputerController.revokeControl()`
 *                                       on every controller, then answer; main grants the next session only after.
 * Main → renderer event: `desktop_slot_update` carrying a {@link DesktopSlotState}.
 */

/** Why a holder lost or let go of the slot. */
export type DesktopSlotReason = "turn_end" | "idle" | "stop" | "lease" | "closed" | "crashed" | "abort";

/** One session in the slot's view. */
export interface DesktopSlotSession {
	tabId: string;
	title: string;
}

/** What the renderer shows: the holder (null when free) and the waiting sessions in grant order. */
export interface DesktopSlotState {
	holder: (DesktopSlotSession & { since: number }) | null;
	queue: DesktopSlotSession[];
}

/** An idle holder (no computer run for this long) lets the slot go; the bridge's timer. */
export const DESKTOP_SLOT_IDLE_MS = 20_000;
/** A holder that shows no progress (no `desktop_slot_touch`) for this long is revoked by main; a hung run. */
export const DESKTOP_SLOT_LEASE_MS = 120_000;

/** The notice an acting run gets instead of running when it had to wait for the slot. */
export const DESKTOP_SLOT_STALE_NOTICE =
	"The desktop was in use by another session while you waited, so the screen may have changed. Nothing was run. Take a fresh screenshot before acting, then repeat the action.";
/** The notice a holder's run gets when the slot was revoked under it. */
export const DESKTOP_SLOT_REVOKED_NOTICE =
	"The desktop slot was taken back (stop, idle lease or tab change); this input did not run. Take a fresh screenshot before acting.";
