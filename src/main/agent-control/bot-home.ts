/**
 * The bot's session (`bot.ts` answers through it), kept by main so the owner never sets it up: pref `bot` names its
 * file, and `ensureBotSession` makes sure that file exists, at each launch once omp is usable and when the sidebar's
 * bot row is clicked before it does. The session is plain stock: `SessionManager.createEmptySessionFile` in the
 * Work workspace, titled through stock's own rename so the index lists it, and marked a chat like "New chat".
 * No omp agent runs and no tab opens for it here.
 */
import { existsSync } from "node:fs";
import { BOT_PREF, botPathOf } from "../../shared/agent-control";

/** What the stock helper made (`sessions.createNamed`). */
export interface CreatedSession {
	sessionPath: string;
	sessionId: string;
}

export interface BotHomeDeps {
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** Whether the owner deleted the session (`deletedSessions`): a tombstoned file is never the bot again. */
	deleted: (sessionPath: string) => boolean;
	/** The Work workspace the bot lives in (`ensureDefaultWorkspace`). */
	workspace: () => string;
	/** The title, by the UI language ("Bot", "봇"). */
	title: () => string;
	/** Makes a titled, listed session file in `cwd` through stock and relists the session index. */
	create: (input: { cwd: string; title: string }) => Promise<CreatedSession>;
	/** Remembers the session as a chat, so the sidebar and a reopen treat it like "New chat". */
	markChat: (sessionId: string) => void;
	/** The pref changed: every window reads it again. */
	changed: (key: string) => void;
	/** Test seam; the file system by default. */
	exists?: (sessionPath: string) => boolean;
}

export class BotHome {
	readonly #deps: BotHomeDeps;
	/** One creation at a time: a launch's pass and a click on the row share it, so no second session is made. */
	#pending: Promise<string> | null = null;

	constructor(deps: BotHomeDeps) {
		this.#deps = deps;
	}

	/** The bot's session file, made first when the pref names none, a missing file or a deleted session. */
	ensureBotSession(): Promise<string> {
		this.#pending ??= this.#ensure().finally(() => {
			this.#pending = null;
		});
		return this.#pending;
	}

	async #ensure(): Promise<string> {
		const { prefs } = this.#deps;
		const named = botPathOf(prefs.get(BOT_PREF));
		const exists = this.#deps.exists ?? existsSync;
		if (named && exists(named) && !this.#deps.deleted(named)) return named;
		const made = await this.#deps.create({ cwd: this.#deps.workspace(), title: this.#deps.title() });
		this.#deps.markChat(made.sessionId);
		prefs.set(BOT_PREF, made.sessionPath);
		this.#deps.changed(BOT_PREF);
		return made.sessionPath;
	}
}
