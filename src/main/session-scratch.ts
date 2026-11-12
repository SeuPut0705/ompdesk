/**
 * A scratch folder per tab that OMPdesk owns (the owner's report, 12 Nov 2026: sessions had left 11 GB in `/tmp` and
 * screenshot folders in the home folder, none of which could be tied to a session afterwards).
 *
 * Every tab's omp gets one folder for the files it makes only to do the work (`SCRATCH_ENV`; the bridge's prompt
 * section tells the agent to use it), named by the tab's process tag (`session-processes.ts`): `<root>/<tag>`, made
 * when the tab's first omp starts and kept for every omp the tab starts, as the tag is. This file keeps which sessions
 * each folder served (`<userData>/session-scratch.json`): a tab that starts a new session keeps its tag and folder,
 * so a folder can hold several sessions' files, and a reply shows a picture by reading its path again each time, so a
 * folder's named files must outlive the tab. Disk care removes the folders (`disk/scratch.ts`).
 *
 * The root is outside the temp folder on purpose: macOS deletes what it finds idle there by itself, which would take
 * a picture an old reply still shows (machine-setup-updates › Disk care has the sources).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { z } from "zod";
import { writeFileAtomicDeferred } from "./atomic-file";

/** The file in userData that names every scratch folder's sessions. */
export const SESSION_SCRATCH_FILE = "session-scratch.json";

/**
 * Where the scratch folders are: short and without a space, since agents paste the path into commands.
 * `~/.cache/ompdesk/scratch`, on Windows `%LOCALAPPDATA%\ompdesk\scratch` (beside the managed tools).
 */
export function defaultScratchRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	return platform === "win32"
		? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ompdesk", "scratch")
		: join(home, ".cache", "ompdesk", "scratch");
}

/** A scratch folder's name: its tab's process tag. */
export const SCRATCH_TAG = /^[0-9a-f]{32}$/;
const ScratchRecordSchema = z.object({
	tag: z.string().regex(SCRATCH_TAG),
	/** When the folder was made. */
	since: z.number(),
	/** Every session file the tab was on while it had this folder, less the deleted ones. */
	sessions: z.array(z.string()),
});
export type ScratchRecord = z.infer<typeof ScratchRecordSchema>;

export interface SessionScratchDeps {
	log(message: string, details: Record<string, string>): void;
	now?(): number;
}

/** A session file as a key: Windows names the same file in either case and with either slash. */
function sessionKey(path: string): string {
	const normal = normalize(path);
	return process.platform === "win32" ? normal.toLowerCase() : normal;
}

export class SessionScratch {
	readonly root: string;
	readonly #file: string;
	readonly #deps: SessionScratchDeps;
	readonly #records = new Map<string, ScratchRecord>();
	#cancelWrite: (() => void) | null = null;

	constructor(file: string, root: string, deps: SessionScratchDeps) {
		this.#file = file;
		this.root = root;
		this.#deps = deps;
		for (const record of this.#read()) this.#records.set(record.tag, record);
	}

	dir(tag: string): string {
		return join(this.root, tag);
	}

	/**
	 * A tab's omp is about to start under `tag`: its folder, made if it is not there (a tab back on its tag finds its
	 * files). Null when it cannot be made; the omp then starts without one.
	 */
	open(tag: string, sessionPath?: string): string | null {
		if (!SCRATCH_TAG.test(tag)) return null;
		const dir = this.dir(tag);
		if (!this.#records.has(tag)) {
			this.#records.set(tag, { tag, since: (this.#deps.now ?? Date.now)(), sessions: [] });
			this.#save();
		}
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (error) {
			this.#deps.log("scratch folder not made", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
		if (sessionPath !== undefined) this.session(tag, sessionPath);
		return dir;
	}

	/** The tab holding `tag` is on `sessionPath` now: one more session whose replies may name the folder's files. */
	session(tag: string, sessionPath: string): void {
		const record = this.#records.get(tag);
		if (!record || record.sessions.some(known => sessionKey(known) === sessionKey(sessionPath))) return;
		record.sessions.push(sessionPath);
		this.#save();
	}

	/** Every folder this app made, with the sessions it served. */
	records(): ScratchRecord[] {
		return [...this.#records.values()].map(record => ({ ...record, sessions: [...record.sessions] }));
	}

	/**
	 * `sessionPath` was deleted: no reply of it will be shown again. Answers the tags of the folders that served it
	 * and now serve no session at all.
	 */
	sessionDeleted(sessionPath: string): string[] {
		const key = sessionKey(sessionPath);
		const emptied: string[] = [];
		let changed = false;
		for (const record of this.#records.values()) {
			const left = record.sessions.filter(known => sessionKey(known) !== key);
			if (left.length === record.sessions.length) continue;
			record.sessions = left;
			changed = true;
			if (left.length === 0) emptied.push(record.tag);
		}
		if (changed) this.#save();
		return emptied;
	}

	/** The folder is gone. */
	forget(tag: string): void {
		if (this.#records.delete(tag)) this.#save();
	}

	#read(): ScratchRecord[] {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
			const scratch =
				typeof parsed === "object" && parsed !== null && "scratch" in parsed ? parsed.scratch : undefined;
			if (!Array.isArray(scratch)) return [];
			return scratch.flatMap((value: unknown) => {
				const record = ScratchRecordSchema.safeParse(value);
				return record.success ? [record.data] : [];
			});
		} catch {
			return [];
		}
	}

	#save(): void {
		this.#cancelWrite?.();
		const scratch = [...this.#records.values()];
		this.#cancelWrite = writeFileAtomicDeferred(
			this.#file,
			`${JSON.stringify({ scratch })}\n`,
			{ mode: 0o600 },
			error => this.#deps.log("scratch records not saved", { error: String(error) }),
		);
	}
}
