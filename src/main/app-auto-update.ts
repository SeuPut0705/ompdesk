/**
 * Settings › Updates & about › Install updates automatically (pref `appAutoUpdate`, default on: only a stored
 * `false` turns it off).
 *
 * Once a verified update is downloaded and installable (relaunch mode or Windows NSIS), the app installs it and
 * restarts by itself — never a modal: one quiet line with a 60 s countdown ("지금 / 나중에") comes first.
 *
 * With Continue interrupted work on (the user's rule: running work goes on after a restart, so an unattended
 * Autopilot Mac updates itself) the countdown starts at the next safe point: no ask or approval card open and no
 * compaction under way (a cut compaction does not resume). A running turn, background subagents and jobs, a focused
 * window and typing do not hold it (2 Nov 2026 a revive ended background subagents; since 4 Nov 2026 the relaunch
 * starts them and the cut commands again, so the owner's call is to restart at once). The restart itself also waits
 * for a safe point when the countdown ends, instead of installing over a card. After the user's "나중에" that round
 * falls back to the rule below.
 *
 * An ask or approval card holds the restart only while someone may answer it (the owner's rule, 12 Nov 2026: a
 * card left open overnight held a downloaded update for 110 minutes): once it has held it for `CARD_HOLD_MS` and
 * nobody gave the computer input for as long, the countdown starts over it, and the relaunch asks the same question
 * again. A plan proposal (lost by a relaunch) and a compaction hold without a cap.
 *
 * With it off (or after "나중에"), a good moment is no tab running a turn and no ask open, and either every window
 * unfocused or no user input for `IDLE_MS`. Still not quiet after `MAX_WAIT_MS`: with Continue interrupted work on
 * it goes ahead anyway; with it off it never forces the restart and keeps waiting for idle.
 *
 * Electron-free so the decisions run under an injected clock; `updater.ts` supplies the facts and
 * the effects, and the restart itself is the existing quit path (`restartIntoUpdate`). Every decision
 * transition (never a tick that changes nothing) goes to the injected `log`, so a restart nobody
 * clicked can be explained afterwards from `gui-runtime.jsonl`.
 */

/** No user input for this long counts as away from the keyboard. */
export const AUTO_INSTALL_IDLE_MS = 2 * 60 * 1000;
/** How long a busy or active window may hold the install back after a "나중에" before it goes anyway (resume on). */
export const AUTO_INSTALL_MAX_WAIT_MS = 30 * 60 * 1000;
/** The notice's countdown before the restart. */
export const AUTO_INSTALL_COUNTDOWN_MS = 60 * 1000;
/**
 * How long an ask or approval card holds the restart while nobody gives the computer input (the owner's ten minutes,
 * 12 Nov 2026); input during that time or during the countdown keeps it waiting.
 */
export const AUTO_INSTALL_CARD_HOLD_MS = 10 * 60 * 1000;

export interface AutoInstallFacts {
	/** The pref `appAutoUpdate`. */
	enabled: boolean;
	/** An update is downloaded and `restartIntoUpdate` can install it (never the manual DMG). */
	installable: boolean;
	/**
	 * The downloaded version failed to start after an earlier automatic install (`update-start-failed.json`): the
	 * scheduler leaves it alone. A person's "Restart & install" does not read this, and a newer version clears it.
	 */
	startFailedBefore?: boolean;
	/** Continue interrupted work after relaunch is on: a restart loses no running work. */
	resumes: boolean;
	/** Some tab runs a turn (or compacts) or an ask is open. */
	busy: boolean;
	/** A card waits on the person: an ask, an approval or a plan proposal (the log names it as the reason). */
	asking?: boolean;
	/**
	 * A plan proposal waits for approval. It lives only in the omp that made it, so a relaunch loses it: it holds the
	 * restart without a cap. An ask or approval comes back (the relaunch reruns the cut-off call).
	 */
	planWaiting?: boolean;
	/** Some tab compacts its context: a restart then would cut the compaction, which does not resume. */
	compacting?: boolean;
	/** One of this app's windows has focus. */
	focused: boolean;
	/** Time since the user's last input anywhere on the computer. */
	idleMs: number;
}

export interface AutoInstallEffects {
	/** The countdown starts: show the notice until `restartAt` (epoch ms). */
	announce(restartAt: number): void;
	/** The notice goes without a restart (postponed, the update is no longer ready). */
	withdraw(): void;
	/** Restart into the update. */
	install(): void;
}

/** Why the scheduler is not installing yet. */
export type AutoInstallWaitReason = "busy turn" | "open ask" | "compaction" | "focused+active input";

/** Who started an install: the scheduler, a click on "Restart & install" (or a paired device's), or a plain quit. */
export type InstallTrigger = "auto" | "user click" | "quit";

export type AutoInstallLogDetails = Record<string, string | number | boolean>;

export interface AutoInstallOptions {
	now: () => number;
	facts: () => AutoInstallFacts;
	effects: AutoInstallEffects;
	idleMs?: number;
	maxWaitMs?: number;
	countdownMs?: number;
	/**
	 * One line per decision transition: `event` (waiting, safe, unattended, quiet, forced, countdown, held, postponed,
	 * withdrawn, install) and its details.
	 */
	log?: (event: string, details?: AutoInstallLogDetails) => void;
}

/** Whether this moment suits a restart. Pure; the one place the "good moment" rule lives. */
export function quietMoment(facts: AutoInstallFacts, idleMs: number = AUTO_INSTALL_IDLE_MS): boolean {
	return !facts.busy && (!facts.focused || facts.idleMs >= idleMs);
}

/** What holds the install back right now; only meaningful when `quietMoment` is false. */
function waitReason(facts: AutoInstallFacts): AutoInstallWaitReason {
	if (facts.busy) {
		if (facts.asking) return "open ask";
		if (facts.compacting) return "compaction";
		return "busy turn";
	}
	return "focused+active input";
}

/**
 * What a resume-on restart must wait for: an open card (its answer would be lost while someone may give it; an ask or
 * approval stops holding once nobody is there, `#cardGivesWay`) or a compaction (a cut one does not resume); else none.
 * Running turns, subagents and jobs are not in it: the relaunch continues them.
 */
function unsafeReason(facts: AutoInstallFacts): "open ask" | "compaction" | undefined {
	if (facts.asking) return "open ask";
	if (facts.compacting) return "compaction";
	return undefined;
}

export class AutoInstallScheduler {
	readonly #opts: AutoInstallOptions;
	/** When the update became installable (or the user last postponed): the max wait counts from here. */
	#waitingSince: number | undefined;
	#restartAt: number | undefined;
	/** The wait reason last logged, so a tick that waits for the same reason writes nothing. */
	#loggedWait: AutoInstallWaitReason | undefined;
	/**
	 * An install began (`installStarted`: the scheduler's own, a click, a paired device's, a quit): the restart is under
	 * way and nothing is left to decide. The app can stay busy for seconds (Windows starts the installer before it
	 * quits), and a tick meanwhile must not announce or install again. The update no longer being installable (the
	 * install failed) or the pref going off starts over.
	 */
	#installed = false;
	/** The user's "나중에" this round: the safe-point rule gives way to a quiet moment or the max wait. */
	#postponed = false;
	/** The reason a resume-on restart at the countdown's end waits for, last logged. */
	#loggedHold: string | undefined;
	/** Since when a card has been open while the update was ready; unset with none open. */
	#cardSince: number | undefined;
	/** The open card gave way (logged `unattended`), until input or a closed card ends that. */
	#cardGaveWay = false;
	/** `withdrawn` for a version that failed to start was logged: once, until it is gone or another one comes. */
	#loggedStartFailed = false;

	constructor(options: AutoInstallOptions) {
		this.#opts = options;
	}

	/** The countdown's deadline while the notice shows. */
	get restartAt(): number | undefined {
		return this.#restartAt;
	}

	/** Re-evaluate; call on a timer and whenever the pref, the status or the work changes. */
	tick(): void {
		const { now, facts, effects } = this.#opts;
		const f = facts();
		const at = now();
		if (!f.enabled || !f.installable) {
			this.#loggedStartFailed = false;
			this.#reset(f.enabled ? "update not ready" : "pref off");
			return;
		}
		if (f.startFailedBefore) {
			// The line is `#reset`'s when a notice was showing; otherwise it is written here, once.
			const shown = this.#restartAt !== undefined;
			this.#reset("start failed before");
			if (!shown && !this.#loggedStartFailed) this.#opts.log?.("withdrawn", { reason: "start failed before" });
			this.#loggedStartFailed = true;
			return;
		}
		this.#loggedStartFailed = false;
		if (this.#installed) return;
		this.#waitingSince ??= at;
		if (f.asking) this.#cardSince ??= at;
		else {
			this.#cardSince = undefined;
			this.#cardGaveWay = false;
		}
		const maxWaitMs = this.#opts.maxWaitMs ?? AUTO_INSTALL_MAX_WAIT_MS;
		const waitedMs = at - this.#waitingSince;
		if (this.#restartAt !== undefined) {
			if (at < this.#restartAt) return;
			// A restart that would stop a running turn asks the user; this one never does, so it waits for idle again.
			if (!f.resumes && f.busy) {
				this.#restartAt = undefined;
				this.#waitingSince = at;
				this.#loggedWait = undefined;
				this.#opts.log?.("withdrawn", { reason: "work started, resume off" });
				effects.withdraw();
				return;
			}
			const hold = f.resumes ? unsafeReason(f) : undefined;
			if (hold === "open ask" && this.#cardGivesWay(f, at)) {
				// Held past an earlier countdown, someone was there then: warn again before restarting over the card.
				if (this.#loggedHold !== undefined) {
					this.#loggedHold = undefined;
					this.#announce(at);
					return;
				}
			} else if (hold) {
				if (hold !== this.#loggedHold) this.#opts.log?.("held", { reason: hold });
				this.#loggedHold = hold;
				return;
			}
			this.installStarted("auto");
			effects.install();
			return;
		}
		if (f.resumes && !this.#postponed) {
			const reason = unsafeReason(f);
			if (reason && !(reason === "open ask" && this.#cardGivesWay(f, at))) {
				if (reason !== this.#loggedWait) {
					this.#loggedWait = reason;
					this.#opts.log?.("waiting", { reason, waitedMs });
				}
				return;
			}
			this.#loggedWait = undefined;
			if (!reason) this.#opts.log?.("safe", { waitedMs, running: f.busy, resume: true });
			this.#announce(at);
			return;
		}
		const quiet = quietMoment(f, this.#opts.idleMs);
		const forced = !quiet && f.resumes && waitedMs >= maxWaitMs;
		if (!quiet && !forced) {
			const reason = waitReason(f);
			if (reason !== this.#loggedWait) {
				this.#loggedWait = reason;
				this.#opts.log?.("waiting", { reason, waitedMs });
			}
			return;
		}
		this.#loggedWait = undefined;
		if (forced) this.#opts.log?.("forced", { waitedMs, maxWaitMs, resume: true, reason: waitReason(f) });
		else this.#opts.log?.("quiet", { waitedMs, idleMs: f.idleMs, focused: f.focused });
		this.#announce(at);
	}

	/**
	 * An open card stops holding the restart once it has held it for `CARD_HOLD_MS` with no input on the computer for
	 * as long; only an ask or approval, which the relaunch asks again, never a plan proposal, and never while a
	 * compaction runs beside it. Logs `unattended` when it gives way; input since (or a closed card) holds again.
	 */
	#cardGivesWay(f: AutoInstallFacts, at: number): boolean {
		const heldMs = at - (this.#cardSince ?? at);
		const gives =
			!f.planWaiting &&
			!f.compacting &&
			heldMs >= AUTO_INSTALL_CARD_HOLD_MS &&
			f.idleMs >= AUTO_INSTALL_CARD_HOLD_MS;
		if (gives && !this.#cardGaveWay) this.#opts.log?.("unattended", { heldMs, idleMs: f.idleMs });
		this.#cardGaveWay = gives;
		return gives;
	}

	/**
	 * An install began, by any trigger: the scheduler's own, a click here or on a paired device, a quit. One `install`
	 * line, then nothing to decide until the update stops being installable (the install failed) or the pref goes off.
	 */
	installStarted(trigger: InstallTrigger): void {
		if (this.#installed) return;
		this.#installed = true;
		this.#restartAt = undefined;
		this.#loggedHold = undefined;
		this.#postponed = false;
		this.#opts.log?.("install", { trigger });
	}

	#announce(at: number): void {
		this.#restartAt = at + (this.#opts.countdownMs ?? AUTO_INSTALL_COUNTDOWN_MS);
		this.#opts.log?.("countdown", { restartAt: this.#restartAt });
		this.#opts.effects.announce(this.#restartAt);
	}

	/** "나중에" on the countdown: drop it; the next try waits for an idle window (the max wait starts over). */
	postpone(): void {
		if (this.#restartAt === undefined) return;
		this.#restartAt = undefined;
		this.#postponed = true;
		this.#loggedHold = undefined;
		this.#waitingSince = this.#opts.now();
		this.#loggedWait = undefined;
		this.#opts.log?.("postponed", { by: "user" });
		this.#opts.effects.withdraw();
	}

	#reset(reason: string): void {
		this.#installed = false;
		this.#postponed = false;
		this.#loggedHold = undefined;
		this.#loggedWait = undefined;
		this.#waitingSince = undefined;
		this.#cardSince = undefined;
		this.#cardGaveWay = false;
		const shown = this.#restartAt !== undefined;
		this.#restartAt = undefined;
		if (!shown) return;
		this.#opts.log?.("withdrawn", { reason });
		this.#opts.effects.withdraw();
	}
}
