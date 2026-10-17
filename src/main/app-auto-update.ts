/**
 * Settings › Updates & about › Install updates automatically (pref `appAutoUpdate`, default off).
 *
 * Once a verified update is downloaded and installable (relaunch mode or Windows NSIS), the app
 * installs it and restarts by itself at a good moment — never a modal: one quiet line with a 60 s
 * countdown ("지금 / 나중에") comes first. A good moment is no tab running a turn and no ask open,
 * and either every window unfocused or no user input for `IDLE_MS`. Still not quiet after `MAX_WAIT_MS`:
 * with Continue interrupted work on (the user's rule: work continues after a restart) it goes ahead
 * anyway; with it off it never forces the restart and keeps waiting for idle.
 *
 * Electron-free so the decisions run under an injected clock; `updater.ts` supplies the facts and
 * the effects, and the restart itself is the existing quit path (`restartIntoUpdate`).
 */

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
}

export interface AutoInstallOptions {
	now: () => number;
	facts: () => AutoInstallFacts;
	effects: AutoInstallEffects;
	idleMs?: number;
	maxWaitMs?: number;
	countdownMs?: number;
}

/** Whether this moment suits a restart. Pure; the one place the "good moment" rule lives. */
export function quietMoment(facts: AutoInstallFacts, idleMs: number = AUTO_INSTALL_IDLE_MS): boolean {
	return !facts.busy && (!facts.focused || facts.idleMs >= idleMs);
}

export class AutoInstallScheduler {
	readonly #opts: AutoInstallOptions;
	/** When the update became installable (or the user last postponed): the max wait counts from here. */
	#waitingSince: number | undefined;
	#restartAt: number | undefined;

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
			this.#reset();
			return;
		}
		this.#waitingSince ??= at;
		if (this.#restartAt !== undefined) {
			if (at < this.#restartAt) return;
			// A restart that would stop running work asks the user; this one never does, so it waits for idle again.
			if (!f.resumes && f.busy) {
				this.#restartAt = undefined;
				this.#waitingSince = at;
				effects.withdraw();
				return;
			}
			this.#restartAt = undefined;
			effects.install();
			return;
		}
		const forced = f.resumes && at - this.#waitingSince >= (this.#opts.maxWaitMs ?? AUTO_INSTALL_MAX_WAIT_MS);
		if (!forced && !quietMoment(f, this.#opts.idleMs)) return;
		this.#restartAt = at + (this.#opts.countdownMs ?? AUTO_INSTALL_COUNTDOWN_MS);
		effects.announce(this.#restartAt);
	}

	/** "나중에": drop the countdown; the next try waits for an idle window (the max wait starts over). */
	postpone(): void {
		if (this.#restartAt === undefined) return;
		this.#restartAt = undefined;
		this.#waitingSince = this.#opts.now();
		this.#opts.effects.withdraw();
	}

	#reset(): void {
		this.#waitingSince = undefined;
		if (this.#restartAt === undefined) return;
		this.#restartAt = undefined;
		this.#opts.effects.withdraw();
	}
}
