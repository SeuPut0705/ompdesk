/**
 * The owner takes over a session the bot opened, and hands it back (`shared/bot-takeover.ts`). Taking over stops the
 * session's turn and starts capturing what the owner types in that session's Terminal panel, wherever they type it
 * (this computer's window, its phone page, a paired device viewing the session here). Handing back tells the session,
 * as a message that starts its turn, when the owner had it and the lines they ran, through the shared safe capture
 * (`terminal-capture.ts`: redacted, password prompts and unechoed lines hidden); the activity log records the take and
 * the hand-back with the line count only. Nothing is kept on disk: a relaunch forgets a takeover, and the session
 * then waits for the owner's next prompt as any stopped session does.
 */

import type { BotTakeover, BotTakeoverRequest, BotTakeoverResult } from "../../shared/bot-takeover";
import { codedError } from "../../shared/ipc-error-codes";
import { CAPTURE_HIDDEN_NO_ECHO, type CaptureSlot, TerminalCapture } from "./terminal-capture";

/** Terminal lines one takeover keeps; later ones are counted, not listed. */
export const TAKEOVER_MAX_LINES = 200;
export const TAKEOVER_LINE_CHARS = 300;

export const TAKEOVER_INSTRUCTION =
	"The owner took this session over and has handed it back. Continue the task from where it stands now: check what the owner's commands changed (git status, the files they touched) before you go on, keep their changes, and do not redo what they did.";

export interface BotTakeoverDeps {
	/** The owner has the bot on: takeovers come from its Tasks. */
	enabled(): boolean;
	/** The title and folder of the tab holding the session here; null when no tab holds it. */
	session(sessionPath: string): { title: string; cwd: string } | null;
	/** Stops the session's turn, when one runs. */
	stop(sessionPath: string): void;
	/** Hands the session the note as a message that starts its turn; rejects when it cannot be reached. */
	deliver(sessionPath: string, note: { id: string; text: string; instruction: string }): Promise<void>;
	/** An entry of the bot's activity log (by the owner). */
	activity(entry: { action: "take_over" | "hand_back"; text: string; sessionPath: string; detail?: string }): void;
	/** The desk's `takeovers` changed. */
	changed(): void;
	now(): number;
}

interface Line extends CaptureSlot {
	at: number;
}

interface Takeover {
	since: number;
	capture: TerminalCapture;
	lines: Line[];
	dropped: number;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class BotTakeovers {
	readonly #deps: BotTakeoverDeps;
	readonly #taken = new Map<string, Takeover>();
	/** A hand-back in flight per session: a second press waits for it instead of telling the session twice. */
	readonly #handing = new Map<string, Promise<BotTakeoverResult>>();

	constructor(deps: BotTakeoverDeps) {
		this.#deps = deps;
	}

	/** The sessions under the owner's control, oldest first; empty while the bot is off. */
	state(): BotTakeover[] {
		if (!this.#deps.enabled()) return [];
		return [...this.#taken].map(([sessionPath, entry]) => ({
			sessionPath,
			since: new Date(entry.since).toISOString(),
		}));
	}

	/** Takes `sessionPath` over: its turn stops, its terminal lines are captured from now. A second take is a no-op. */
	take(sessionPath: string): void {
		if (!this.#deps.enabled()) throw codedError("bot_off", "The bot is off on this computer");
		const session = this.#deps.session(sessionPath);
		if (!session) throw codedError("session_not_open", "No tab on this computer holds that session");
		this.#deps.stop(sessionPath);
		if (this.#taken.has(sessionPath)) return;
		this.#taken.set(sessionPath, {
			since: this.#deps.now(),
			capture: new TerminalCapture(TAKEOVER_LINE_CHARS),
			lines: [],
			dropped: 0,
		});
		this.#deps.activity({ action: "take_over", text: session.title, sessionPath });
		this.#deps.changed();
	}

	/**
	 * Hands `sessionPath` back: the note reaches the session and starts its turn. A delivery that fails keeps the
	 * takeover as it was, so Hand back can be pressed again. A session not taken over answers `{}`.
	 */
	handBack(sessionPath: string): Promise<BotTakeoverResult> {
		let pending = this.#handing.get(sessionPath);
		if (!pending) {
			pending = this.#handBack(sessionPath).finally(() => this.#handing.delete(sessionPath));
			this.#handing.set(sessionPath, pending);
		}
		return pending;
	}

	async #handBack(sessionPath: string): Promise<BotTakeoverResult> {
		const entry = this.#taken.get(sessionPath);
		if (!entry) return {};
		const session = this.#deps.session(sessionPath);
		const end = this.#deps.now();
		await this.#deps.deliver(sessionPath, {
			id: `takeover-${entry.since}`,
			text: this.#note(entry, end, session?.cwd),
			instruction: TAKEOVER_INSTRUCTION,
		});
		if (this.#taken.get(sessionPath) === entry) this.#taken.delete(sessionPath);
		const lines = entry.lines.length;
		this.#deps.activity({
			action: "hand_back",
			text: session?.title ?? "",
			sessionPath,
			detail: lines === 1 ? "1 terminal line" : `${lines} terminal lines`,
		});
		this.#deps.changed();
		return { lines };
	}

	/** The bot was turned off: every takeover ends without a note (the sessions wait for the owner's prompt). */
	clear(): void {
		if (this.#taken.size === 0) return;
		this.#taken.clear();
		this.#deps.changed();
	}

	/**
	 * Raw input the owner typed in terminal `terminal` (a key unique to that PTY, e.g. `<owner>|<id>`) of the session
	 * at `sessionPath`. Ignored unless that session is taken over.
	 */
	terminalWrite(sessionPath: string, terminal: string, data: string): void {
		const entry = this.#taken.get(sessionPath);
		if (!entry) return;
		const at = this.#deps.now();
		entry.capture.write(terminal, data, () => {
			if (entry.lines.length >= TAKEOVER_MAX_LINES) {
				entry.dropped++;
				return null;
			}
			const line: Line = { at, text: CAPTURE_HIDDEN_NO_ECHO };
			entry.lines.push(line);
			return line;
		});
	}

	/** What terminal `terminal` of the session printed, ending at stream `offset` (one viewer's answer). */
	terminalOutput(sessionPath: string, terminal: string, offset: number, output: string): void {
		this.#taken.get(sessionPath)?.capture.output(terminal, offset, output);
	}

	#note(entry: Takeover, end: number, cwd: string | undefined): string {
		const lines = [
			`The owner took this session over at ${iso(entry.since)} and handed it back at ${iso(end)} (UTC). Your turn was stopped meanwhile.`,
		];
		if (entry.lines.length === 0) {
			lines.push("They ran nothing in this session's terminal.");
			return lines.join("\n");
		}
		lines.push(`What they ran in this session's terminal${cwd ? ` (folder ${cwd})` : ""}, in order:`);
		for (const line of entry.lines) lines.push(`  ${iso(line.at)} $ ${line.text}`);
		if (entry.dropped > 0)
			lines.push(`Cut at ${TAKEOVER_MAX_LINES} lines: ${entry.dropped} later line(s) are not listed.`);
		return lines.join("\n");
	}
}

/** `BOT_TAKEOVER` and `host.botDesk.takeover`. */
export async function takeoverAction(takeovers: BotTakeovers, request: BotTakeoverRequest): Promise<BotTakeoverResult> {
	if (request.action === "take") {
		takeovers.take(request.sessionPath);
		return {};
	}
	return takeovers.handBack(request.sessionPath);
}
