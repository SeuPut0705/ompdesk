/**
 * Settings › Updates & about › Install updates automatically (pref `appAutoUpdate`, default on: only a stored
 * `false` turns it off).
 *
 * Once a verified update is downloaded and installable (relaunch mode or Windows NSIS), the app installs it and
 * restarts by itself — never a modal: one quiet line with a 60 s countdown ("지금 / 나중에") comes first.
 *
 * With Continue interrupted work on (the user's rule: running work goes on after a restart, so an unattended
 * Autopilot Mac updates itself) the countdown starts at the next safe point: no ask or approval card open, no
 * compaction under way and no background subagent or job running (a revive starts those over, so the work done so far
 * is lost: 2 Nov 2026). A running turn, a focused window and typing do not hold it; the restart itself also waits
 * for a safe point when the countdown ends. Background work holds for at most `MAX_WAIT_MS`. After the user's
 * "나중에" that round falls back to the rule below.
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

import { type BackgroundWork, hasBackgroundWork, NO_BACKGROUND_WORK } from "./background-work";

/** No user input for this long counts as away from the keyboard. */
export const AUTO_INSTALL_IDLE_MS = 2 * 60 * 1000;
/** How long a busy or active window may hold the install back before a resume-on app restarts anyway. */
export const AUTO_INSTALL_MAX_WAIT_MS = 30 * 60 * 1000;
/** The notice's countdown before the restart. */
export const AUTO_INSTALL_COUNTDOWN_MS = 60 * 1000;

export interface AutoInstallFacts {
	/** The pref `appAutoUpdate`. */
	enabled: boolean;
	/** An update is downloaded and `restartIntoUpdate` can install it (never the manual DMG). */
	installable: boolean;
	/** Continue interrupted work after relaunch is on: a restart loses no running work. */
	resumes: boolean;
	/** Some tab runs a turn (or compacts) or an ask is open. */
	busy: boolean;
	/** An ask or approval card is open (the log names it as the reason, instead of a running turn). */
	asking?: boolean;
	/** Some tab compacts its context: a restart then would cut the compaction, which does not resume. */
	compacting?: boolean;
	/** Running background subagents and jobs of every tab on this computer (src/main/background-work.ts). */
	backgroundWork?: BackgroundWork;
	/** The probe has not answered yet since the update became installable: decide nothing with resume on. */
	backgroundWorkPending?: boolean;
	/**
	 * When the request `backgroundWork` answers began (epoch ms). The restart at the countdown's end goes only on an
	 * answer asked at or after the deadline: the cached one can be seconds old, and work started in those seconds would
	 * be cut.
	 */
	backgroundWorkAskedAt?: number;
	/** One of this app's windows has focus. */
	focused: boolean;
	/** Time since the user's last input anywhere on the computer. */
	idleMs: number;
}

export interface AutoInstallEffects {
	/** The countdown starts: show the notice until `restartAt` (epoch ms). */
	announce(restartAt: number): void;
	/** The countdown ends without a restart (postponed, or the update is no longer ready). */
	withdraw(): void;
	/** Restart into the update. */
	install(): void;
	/** Ask the background-work probe again now, and tick once its answer landed (`backgroundWorkAskedAt` moves). */
	verify?(): void;
}

/** Why the scheduler is not installing yet. */
export type AutoInstallWaitReason =
	| "busy turn"
	| "open ask"
	| "compaction"
	| "background work"
	| "focused+active input";

export type AutoInstallLogDetails = Record<string, string | number | boolean>;

export interface AutoInstallOptions {
	now: () => number;
	facts: () => AutoInstallFacts;
	effects: AutoInstallEffects;
	idleMs?: number;
	maxWaitMs?: number;
	countdownMs?: number;
	/** One line per decision transition: `event` (waiting, quiet, forced, countdown, postponed, withdrawn, install) and its details. */
	log?: (event: string, details?: AutoInstallLogDetails) => void;
}

/** Whether this moment suits a restart. Pure; the one place the "good moment" rule lives. */
export function quietMoment(facts: AutoInstallFacts, idleMs: number = AUTO_INSTALL_IDLE_MS): boolean {
	return !facts.busy && !hasBackgroundWork(workOf(facts)) && (!facts.focused || facts.idleMs >= idleMs);
}

function workOf(facts: AutoInstallFacts): BackgroundWork {
	return facts.backgroundWork ?? NO_BACKGROUND_WORK;
}

/** What holds the install back right now; only meaningful when `quietMoment` is false. */
function waitReason(facts: AutoInstallFacts): AutoInstallWaitReason {
	if (facts.busy || hasBackgroundWork(workOf(facts))) {
		if (facts.asking) return "open ask";
		if (facts.compacting) return "compaction";
		return hasBackgroundWork(workOf(facts)) ? "background work" : "busy turn";
	}
	return "focused+active input";
}

/**
 * What a resume-on restart must wait for: an open card (its answer would be lost), a compaction (a cut one does not
 * resume), or background subagents and jobs (a revive restarts them from the start, so the work done so far is lost
 * once more: the 2 Nov 2026 update cut LayoutSplit mid-`bash` and the parent redid it all); else none.
 */
function unsafeReason(facts: AutoInstallFacts): "open ask" | "compaction" | "background work" | undefined {
	if (facts.asking) return "open ask";
	if (facts.compacting) return "compaction";
	return hasBackgroundWork(workOf(facts)) ? "background work" : undefined;
}

export class AutoInstallScheduler {
	readonly #opts: AutoInstallOptions;
	/** When the update became installable (or the user last postponed): the max wait counts from here. */
	#waitingSince: number | undefined;
	#restartAt: number | undefined;
	/** The wait reason last logged, so a tick that waits for the same reason writes nothing. */
	#loggedWait: AutoInstallWaitReason | undefined;
	/**
	 * `install` ran: the restart is under way and nothing is left to decide. The app can stay busy for seconds
	 * (Windows starts the installer before it quits), and a tick meanwhile must not announce or install again.
	 * The update no longer being installable (the install failed) or the pref going off starts over.
	 */
	#installed = false;
	/** The user's "나중에" this round: the safe-point rule gives way to a quiet moment or the max wait. */
	#postponed = false;
	/** The reason a resume-on restart at the countdown's end waits for, last logged. */
	#loggedHold: string | undefined;
	/** This countdown's end asked the probe for a fresh look (once per countdown). */
	#verifyAsked = false;

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
			this.#reset(f.enabled ? "update not ready" : "pref off");
			return;
		}
		if (this.#installed) return;
		this.#waitingSince ??= at;
		// The probe has not answered yet this live period: an empty reading is not "no background work".
		if (f.resumes && f.backgroundWorkPending) return;
		const maxWaitMs = this.#opts.maxWaitMs ?? AUTO_INSTALL_MAX_WAIT_MS;
		const waitedMs = at - this.#waitingSince;
		if (this.#restartAt !== undefined) {
			if (at < this.#restartAt) return;
			// A restart that would stop running work asks the user; this one never does, so it waits for idle again.
			if (!f.resumes && (f.busy || hasBackgroundWork(workOf(f)))) {
				this.#restartAt = undefined;
				this.#waitingSince = at;
				this.#loggedWait = undefined;
				this.#opts.log?.("withdrawn", { reason: "work started, resume off" });
				effects.withdraw();
				return;
			}
			// The cached answer can be seconds old: the restart goes only on one asked at or after the deadline, so work
			// started just before it holds. Past the max wait background work no longer holds, so nothing is asked.
			const stale = f.backgroundWorkAskedAt === undefined || f.backgroundWorkAskedAt < this.#restartAt;
			if (f.resumes && f.backgroundWork !== undefined && stale && waitedMs < maxWaitMs) {
				if (!this.#verifyAsked) {
					this.#verifyAsked = true;
					effects.verify?.();
				}
				return;
			}
			// Running turns resume after the restart; an open card or a compaction would not, and background work would
			// start over: the restart waits. Background work holds only up to the max wait.
			const hold = f.resumes ? unsafeReason(f) : undefined;
			if (hold && !(hold === "background work" && waitedMs >= maxWaitMs)) {
				if (hold !== this.#loggedHold) this.#opts.log?.("held", { reason: hold });
				this.#loggedHold = hold;
				return;
			}
			if (hold) this.#opts.log?.("forced", { waitedMs, maxWaitMs, resume: true, reason: hold });
			this.#restartAt = undefined;
			this.#loggedHold = undefined;
			this.#installed = true;
			this.#postponed = false;
			this.#opts.log?.("install", { trigger: "auto" });
			effects.install();
			return;
		}
		if (f.resumes && !this.#postponed) {
			const reason = unsafeReason(f);
			if (reason && !(reason === "background work" && waitedMs >= maxWaitMs)) {
				if (reason !== this.#loggedWait) {
					this.#loggedWait = reason;
					this.#opts.log?.("waiting", { reason, waitedMs });
				}
				return;
			}
			this.#loggedWait = undefined;
			if (reason) this.#opts.log?.("forced", { waitedMs, maxWaitMs, resume: true, reason });
			else this.#opts.log?.("safe", { waitedMs, running: f.busy, resume: true });
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

	#announce(at: number): void {
		this.#restartAt = at + (this.#opts.countdownMs ?? AUTO_INSTALL_COUNTDOWN_MS);
		this.#verifyAsked = false;
		this.#opts.log?.("countdown", { restartAt: this.#restartAt });
		this.#opts.effects.announce(this.#restartAt);
	}

	/** "나중에": drop the countdown; the next try waits for an idle window (the max wait starts over). */
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
		this.#waitingSince = undefined;
		if (this.#restartAt === undefined) return;
		this.#restartAt = undefined;
		this.#opts.log?.("withdrawn", { reason });
		this.#opts.effects.withdraw();
	}
}
