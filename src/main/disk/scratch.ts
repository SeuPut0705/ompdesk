/**
 * Disk care for the sessions' scratch folders (`session-scratch.ts`: one folder per tab, named by its process tag).
 * A folder goes
 * - when the last session it served is deleted: at once, whole (`sessionDeleted`);
 * - in a run (`sweep`), once no tab holds its tag (a tab of this launch, or one the last launch left that may still
 *   come back), nothing in it changed for `DISK_CARE_ARTIFACT_IDLE_DAYS` and no running process carries its tag:
 *   everything but the files its sessions' replies name, which stay until those sessions are deleted (a reply reads
 *   its picture from the path each time it is shown). A folder whose sessions are all gone waits for no idle days.
 *
 * Kept whole instead: a folder whose session file cannot be read as stock's, one this app has no record of (its
 * sessions are not known) unless it is empty, and every folder where the running processes cannot be listed.
 * Reading and removing are the core's (`crates/core/src/disk/scratch.rs`); what is in use is main's.
 */
import * as path from "node:path";
import { promises as fs } from "original-fs";
import { DISK_CARE_ARTIFACT_IDLE_DAYS } from "../../shared/disk-care";
import { CoreError } from "../core/process";
import { coreHeld } from "../local/git/exec";
import { SCRATCH_TAG, type SessionScratch } from "../session-scratch";

const DAY_MS = 24 * 60 * 60_000;
const READ_MS = 10 * 60_000;
const SWEEP_MS = 30 * 60_000;

export interface ScratchCareDeps {
	store: Pick<SessionScratch, "root" | "dir" | "records" | "sessionDeleted" | "forget">;
	/** The tags a tab holds, or the last launch left for a tab that may come back. */
	heldTags(): ReadonlySet<string>;
	/** Every running process with its tag; null when they cannot be listed. */
	processes(): Promise<ReadonlyArray<{ tag?: string }> | null>;
	/** Every stored session file of this computer: a session moved to another folder keeps its file name. */
	sessionFiles(): Promise<readonly string[]>;
	/** One `disk-care` line. */
	log(message: string, details: Record<string, unknown>): void;
	now?(): number;
}

/** What a run did to the scratch folders, for its summary. */
export interface ScratchSweep {
	/** The bytes of each folder something was removed from. */
	removed: number[];
	kept: number;
	failed: number;
}

interface Swept {
	bytes: number;
	removed: number;
	kept: number;
	left: number;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ScratchCare {
	readonly #deps: ScratchCareDeps;

	constructor(deps: ScratchCareDeps) {
		this.#deps = deps;
	}

	get root(): string {
		return this.#deps.store.root;
	}

	/** A session file of this computer was deleted: the folders that served only it go now, whole. */
	async sessionDeleted(sessionPath: string): Promise<void> {
		for (const tag of this.#deps.store.sessionDeleted(sessionPath)) {
			// A tab still on the tag (it moved to a session not written yet) keeps its folder; a run takes it later.
			if (this.#deps.heldTags().has(tag)) continue;
			const dir = this.#deps.store.dir(tag);
			try {
				await this.#remove(dir, tag, [], "its session was deleted");
			} catch (error) {
				this.#deps.log("failed", { step: "scratch", path: dir, error: errorText(error) });
			}
		}
	}

	/** One pass over every folder under the root. */
	async sweep(): Promise<ScratchSweep> {
		const result: ScratchSweep = { removed: [], kept: 0, failed: 0 };
		const now = (this.#deps.now ?? Date.now)();
		const names = await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [] as string[];
			throw error;
		});
		const records = new Map(this.#deps.store.records().map(record => [record.tag, record]));
		// A record whose folder is gone (removed by hand) names nothing any more.
		for (const tag of records.keys()) {
			if (!names.includes(tag) && !this.#deps.heldTags().has(tag)) this.#deps.store.forget(tag);
		}
		// Listed once, and only when a folder is otherwise ready to go.
		let listed: Promise<ReadonlyArray<{ tag?: string }> | null> | undefined;
		let stored: Promise<readonly string[]> | undefined;
		const keep = (dir: string, reason: string): void => {
			result.kept++;
			this.#deps.log("kept", { path: dir, reason });
		};
		for (const tag of names) {
			// Only what this app's tabs were given: any other entry of the folder is not ours to judge.
			if (!SCRATCH_TAG.test(tag) || this.#deps.heldTags().has(tag)) continue;
			const dir = this.#deps.store.dir(tag);
			try {
				const facts = await coreHeld<{ newestMs: number; entries: number }>("disk.scratchFacts", { dir }, READ_MS);
				const record = records.get(tag);
				if (!record && facts.entries > 0) {
					keep(dir, "its sessions are not known");
					continue;
				}
				stored ??= this.#deps.sessionFiles();
				const sessions = record ? await existing(record.sessions, await stored) : [];
				if (sessions.length > 0 && (now - facts.newestMs) / DAY_MS < DISK_CARE_ARTIFACT_IDLE_DAYS) continue;
				listed ??= this.#deps.processes();
				const processes = await listed;
				if (processes === null || processes.some(process => process.tag === tag)) {
					keep(dir, processes === null ? "process check unavailable" : "a process of its session runs");
					continue;
				}
				// A tab may have taken the tag over while the folder was read.
				if (this.#deps.heldTags().has(tag)) continue;
				const bytes = await this.#remove(
					dir,
					tag,
					sessions,
					sessions.length > 0 ? "idle" : "its sessions are gone",
				);
				if (bytes !== null) result.removed.push(bytes);
			} catch (error) {
				if (error instanceof CoreError && error.code === "scratch_kept") {
					keep(dir, error.message);
					continue;
				}
				result.failed++;
				this.#deps.log("failed", { step: "scratch", path: dir, error: errorText(error) });
			}
		}
		return result;
	}

	/** The core's sweep of one folder; the bytes that went, or null when nothing did. */
	async #remove(dir: string, tag: string, sessions: readonly string[], reason: string): Promise<number | null> {
		const swept = await coreHeld<Swept>("disk.scratchSweep", { dir, sessions }, SWEEP_MS);
		if (swept.kept === 0 && swept.left === 0) this.#deps.store.forget(tag);
		if (swept.removed === 0) return null;
		this.#deps.log("scratch", {
			path: dir,
			bytes: swept.bytes,
			reason,
			...(swept.kept > 0 ? { shownInReplies: swept.kept } : {}),
			...(swept.left > 0 ? { left: swept.left } : {}),
		});
		return swept.bytes;
	}
}

/** The session files of `recorded` that are still there: at their path, or where the session was moved to. */
async function existing(recorded: readonly string[], stored: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const session of recorded) {
		const there = await fs.access(session).then(
			() => true,
			() => false,
		);
		const moved = there ? undefined : stored.find(file => path.basename(file) === path.basename(session));
		if (there) found.push(session);
		else if (moved) found.push(moved);
	}
	return found;
}
