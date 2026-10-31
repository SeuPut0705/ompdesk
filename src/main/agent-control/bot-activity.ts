/**
 * The bot's activity log (`shared/bot-activity.ts`): main appends, windows read a page on demand. Kept in
 * `<userData>/bot-activity.json`, the newest `BOT_ACTIVITY_KEPT` entries; written a moment after a burst of appends
 * (a turn's tool calls come many at once) and at `flush`, never once per entry.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
	BOT_ACTIVITY_KEPT,
	BOT_ACTIVITY_PAGE,
	BOT_ACTIVITY_TEXT_MAX,
	type BotActivity,
	type BotActivityDraft,
	type BotActivityPage,
	BotActivitySchema,
} from "../../shared/bot-activity";
import { writeFileAtomicDeferred } from "../atomic-file";

/** Appends within this long go to disk together. */
export const BOT_ACTIVITY_WRITE_MS = 500;

export interface BotActivityOptions {
	/** Where the log lives; null keeps it in memory only. */
	file: string | null;
	now?: () => Date;
	newId?: () => string;
}

function read(file: string): BotActivity[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
		const list = z.array(z.unknown()).safeParse(raw);
		if (!list.success) return [];
		// One damaged entry costs only itself.
		return list.data.flatMap(item => {
			const entry = BotActivitySchema.safeParse(item);
			return entry.success ? [entry.data] : [];
		});
	} catch {
		return [];
	}
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > BOT_ACTIVITY_TEXT_MAX ? `${flat.slice(0, BOT_ACTIVITY_TEXT_MAX - 1)}…` : flat;
}

export class BotActivityLog {
	readonly #file: string | null;
	readonly #now: () => Date;
	readonly #newId: () => string;
	#entries: BotActivity[];
	#revision = 0;
	#timer: NodeJS.Timeout | undefined;

	constructor(options: BotActivityOptions) {
		this.#file = options.file;
		this.#now = options.now ?? (() => new Date());
		this.#newId = options.newId ?? (() => randomBytes(6).toString("hex"));
		this.#entries = options.file ? read(options.file).slice(-BOT_ACTIVITY_KEPT) : [];
	}

	append(draft: BotActivityDraft): BotActivity {
		const entry: BotActivity = {
			...draft,
			text: oneLine(draft.text),
			id: this.#newId(),
			at: this.#now().toISOString(),
		};
		this.#entries.push(entry);
		if (this.#entries.length > BOT_ACTIVITY_KEPT) this.#entries.splice(0, this.#entries.length - BOT_ACTIVITY_KEPT);
		this.#changed();
		return entry;
	}

	get(id: string): BotActivity | undefined {
		return this.#entries.find(entry => entry.id === id);
	}

	/** Every entry kept, oldest first. */
	entries(): readonly BotActivity[] {
		return this.#entries;
	}

	/** The newest `limit` entries, oldest first, with the revision they are as of. */
	page(limit = BOT_ACTIVITY_PAGE): BotActivityPage {
		return {
			entries: this.#entries.slice(-Math.max(1, Math.min(limit, BOT_ACTIVITY_PAGE))),
			revision: this.#revision,
		};
	}

	/** The entry's change was taken back: it offers no Undo again. */
	markUndone(id: string): void {
		const index = this.#entries.findIndex(entry => entry.id === id);
		const entry = this.#entries[index];
		if (!entry || entry.undone) return;
		this.#entries[index] = { ...entry, undone: true };
		this.#changed();
	}

	/** Writes what is waiting now (quit, tests). */
	flush(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#write();
	}

	#changed(): void {
		this.#revision++;
		if (!this.#file || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#write();
		}, BOT_ACTIVITY_WRITE_MS);
		this.#timer.unref();
	}

	#write(): void {
		if (!this.#file) return;
		writeFileAtomicDeferred(this.#file, JSON.stringify(this.#entries), { mode: 0o600 }, error =>
			console.warn(`[bot-activity] the log could not be written: ${error}`),
		);
	}
}
