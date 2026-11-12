/**
 * Sessions tell each other things (the mailbox): an opened session reports to the session that opened it
 * (`ompdesk_report`), and siblings of one opener can write to each other, instead of the opener polling. The rules
 * (the wrapper a report arrives in, dispatch ids, coalescing, the outbox) live in the Rust core
 * (`native/ompdesk/crates/core/src/agentctl/rules/mail.rs`, `journal/mail_outbox.rs`); what stays here is the kinds the
 * tool schema lists and how stock delivers each, which the bridge tests and main's host seam read.
 *
 *   question, blocked,  `aside` + `triggerTurn`: an idle receiver starts a turn on it. A question or blocker is
 *   done, review        answered with `ompdesk_session_send` or by the user; nothing answers it on its own.
 *   progress, note      no turn (`triggerTurn: false`): shown at once when the receiver is idle; while a turn runs the
 *                       receiver's bridge sends it as an `aside` too, so the model reads it between its steps.
 */

export const MAIL_KINDS = ["progress", "done", "blocked", "question", "review", "note"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface MailDelivery {
	triggerTurn: boolean;
	deliverAs?: "aside";
}

/** How stock delivers a report of this kind (a no-turn one becomes an `aside` in the receiver's bridge while a turn runs). */
export function deliveryFor(kind: MailKind): MailDelivery {
	switch (kind) {
		case "question":
		case "blocked":
		case "done":
		case "review":
			return { triggerTurn: true, deliverAs: "aside" };
		default:
			return { triggerTurn: false };
	}
}
