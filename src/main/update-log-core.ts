/**
 * Pure pieces of the app update's decision log (`gui-runtime.jsonl`, source `app-update`): text that is
 * safe to write, what `swap.log` says about the last swap, and the line the next launch writes about it.
 * Electron-free; `updater.ts` writes the lines through the runtime log.
 */

import { redactDiagnosticsText } from "../../resources/gui-bridge/redactor";

export type UpdateLogDetails = Record<string, string | number | boolean>;

/** The reason text of a failure is cut here: a log line, not the whole raw error. */
const MAX_REASON_LENGTH = 300;

/**
 * An error or reason made safe for the log: the update token and every URL (a signed asset URL carries
 * credentials in its query) are gone, then the diagnostics redactor takes what it knows.
 */
export function scrubUpdateText(text: string, secrets: readonly (string | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets) if (secret) out = out.split(secret).join("<token>");
	out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
	out = redactDiagnosticsText(out);
	return out.length <= MAX_REASON_LENGTH ? out : `${out.slice(0, MAX_REASON_LENGTH)}…`;
}

/**
 * A line the shell's updater sends for the runtime log (`log.runtime`, source `app-update`), its `reason` made safe as
 * `scrubUpdateText` makes it (the shell already cut the token out). Lines of any other source pass unchanged.
 */
export function scrubUpdateReport<T extends { source?: string; details?: object }>(report: T): T {
	if (report.source !== "app-update" || !report.details || !("reason" in report.details)) return report;
	const { reason } = report.details as { reason?: unknown };
	if (typeof reason !== "string") return report;
	return { ...report, details: { ...report.details, reason: scrubUpdateText(reason) } };
}

/** How the install ends once the app exits: macOS's detached swap helper, or Windows' NSIS installer. */
export type InstallHelperMode = "relaunch" | "nsis";

/** What an install leaves for the next launch to report (`<userData>/update-install.json`). */
export interface PendingInstall {
	/** The version that started the install. */
	from: string;
	/** The version it should become. */
	to: string;
	mode: InstallHelperMode;
	/** Who started it: auto, user click or quit. */
	trigger: string;
	/** Epoch ms the helper was launched. */
	at: number;
	/** How the app's windows sat when the install began, so the relaunch comes back the same way (absent: in front). */
	presence?: WindowPresence;
}

/**
 * How the windows sat when an install began: all hidden (closed to the tray, or the macOS app with no window
 * shown), all minimized, or shown while another app had the focus. The relaunch an automatic update makes opens
 * them that way instead of in front of the person.
 */
export type WindowPresence = "hidden" | "minimized" | "behind";

export function windowPresenceOf(
	windows: readonly { visible: boolean; minimized: boolean; focused: boolean }[],
): WindowPresence | undefined {
	const shown = windows.filter(win => win.visible);
	if (shown.length === 0) return windows.length > 0 ? "hidden" : undefined;
	if (shown.every(win => win.minimized)) return "minimized";
	if (!windows.some(win => win.focused)) return "behind";
	return undefined;
}

/** The relaunch an install made reads its presence only this soon after the helper started; a later launch is the person's. */
export const RELAUNCH_PRESENCE_MS = 15 * 60_000;

export function relaunchPresence(pending: PendingInstall | undefined, now: number): WindowPresence | undefined {
	if (!pending?.presence || now - pending.at > RELAUNCH_PRESENCE_MS || now < pending.at) return undefined;
	return pending.presence;
}

export function parsePendingInstall(raw: string): PendingInstall | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { from, to, mode, trigger, at, presence } = value as Record<string, unknown>;
	if (typeof from !== "string" || typeof to !== "string" || typeof trigger !== "string" || typeof at !== "number") {
		return undefined;
	}
	if (mode !== "relaunch" && mode !== "nsis") return undefined;
	return {
		from,
		to,
		mode,
		trigger,
		at,
		...(presence === "hidden" || presence === "minimized" || presence === "behind" ? { presence } : {}),
	};
}

/**
 * The lines the swap script closes an entry with (`SWAP_SCRIPT` in updater-state.ts). A relaunch swap prints two:
 * `installed` once the bundle is exchanged, then how the new app's start ended (`started`, or one of the
 * `start failed` lines, which also say what is in place now). The last one wins. The new shell's launcher appends its
 * own entry (`swap <date>: start check <bundle> -> <bundle>`) ending `started`, `start failed; the swap restores`,
 * `start failed; previous app restored` or `start failed; restore failed: <why>`.
 */
const SWAP_OUTCOMES: readonly string[] = [
	"installed",
	"started",
	"start failed; previous app restored",
	"start failed; previous app lost",
	"start failed; the swap restores",
	"install failed; previous app restored",
	"copy failed",
	"cannot move old app",
	"staged app missing",
	"app still running; swap skipped",
];

/** The new macOS shell's launcher ends a failed restore with its reason after this prefix. */
const RESTORE_FAILED_PREFIX = "start failed; restore failed:";

const isSwapOutcome = (line: string): boolean => SWAP_OUTCOMES.includes(line) || line.startsWith(RESTORE_FAILED_PREFIX);

export interface SwapLogEntry {
	/** The date the script printed when it started. */
	at: string;
	/** The script's last closing line, or `unknown` when it printed none (killed, or still running). */
	outcome: string;
}

/** The last swap in `swap.log`: from its last `swap <date>: <src> -> <dest>` header to the end. */
export function lastSwapEntry(log: string): SwapLogEntry | undefined {
	const lines = log.split(/\r?\n/);
	for (let start = lines.length - 1; start >= 0; start--) {
		const header = /^swap (.+?): .+ -> .+$/.exec(lines[start] ?? "");
		if (!header) continue;
		const outcome = lines
			.slice(start + 1)
			.map(line => line.trim())
			.findLast(isSwapOutcome);
		return { at: header[1] ?? "", outcome: outcome ?? "unknown" };
	}
	return undefined;
}

/** A version whose start failed after an install (`<userData>/update-start-failed.json`): the automatic install leaves it. */
export interface StartFailure {
	version: string;
	/** Failed starts reported for this version (the NSIS setup of the Rust shell shares the file). */
	count: number;
	/** Epoch ms the last failed start was reported. */
	at: number;
}

export const START_FAILED_FILE = "update-start-failed.json";

/**
 * The first launch after an install ended on a start failure: not the version the install should have produced,
 * and the last `swap.log` outcome says the new app did not start (`start failed; …`: the swap helper's, or the new
 * shell's launcher, which appends the same lines). Returns what to remember so the automatic install does not try that
 * version again (`count`: how many starts of it failed, one more than the file already holds for that version);
 * `undefined` for a good install, an install the log says nothing about, or one that failed to copy.
 */
export function startFailureOf(
	pending: PendingInstall,
	currentVersion: string,
	swap: SwapLogEntry | undefined,
	at: number,
	earlier?: StartFailure,
): StartFailure | undefined {
	if (!swap?.outcome.startsWith("start failed")) return undefined;
	if (currentVersion === pending.to || pending.to === "unknown") return undefined;
	return { version: pending.to, count: earlier?.version === pending.to ? earlier.count + 1 : 1, at };
}

export function parseStartFailure(raw: string): StartFailure | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") return undefined;
		const { version, count, at } = value as Record<string, unknown>;
		if (typeof version !== "string" || typeof at !== "number") return undefined;
		return { version, count: typeof count === "number" && count >= 1 ? Math.floor(count) : 1, at };
	} catch {
		return undefined;
	}
}

/**
 * The start mark (`<userData>/app-started.json`): main writes it once per launch, after the first window's page
 * loaded. A macOS swap helper that reopened the new app polls for it (`SWAP_SCRIPT`), and puts the previous app back
 * when the expected version never marks. The helper reads the version with a fixed-string match on
 * `"version":"<x>"`, so the JSON stays compact.
 */
export const START_MARK_FILE = "app-started.json";

export function startMarkJson(version: string, pid: number, at: number): string {
	return JSON.stringify({ version, pid, at });
}

/**
 * The one line the first launch after an install writes: the version before, the one the install
 * should have produced, and the one now running. Running the new version is `installed`; the old one
 * is `rolled back`; anything else is `changed`. macOS adds what the last `swap.log` entry says.
 */
export function previousInstallDetails(
	pending: PendingInstall,
	currentVersion: string,
	swap?: SwapLogEntry,
): UpdateLogDetails {
	const outcome =
		currentVersion === pending.to ? "installed" : currentVersion === pending.from ? "rolled back" : "changed";
	return {
		event: "result",
		outcome,
		previous: pending.from,
		expected: pending.to,
		current: currentVersion,
		mode: pending.mode,
		trigger: pending.trigger,
		launchedAt: new Date(pending.at).toISOString(),
		...(swap ? { swapAt: swap.at, swapOutcome: swap.outcome } : {}),
	};
}
