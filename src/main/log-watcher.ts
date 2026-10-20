/**
 * Tails ~/.omp/logs/omp.*.log files for the Logs view.
 *
 * One fs.watch on the directory drives everything: it names the file that was created or written (FSEvents on
 * macOS, inotify on Linux, ReadDirectoryChangesW on Windows), and only that file is read, from its stored offset,
 * through a stream that closes when the read ends. Never a watch per file: omp writes one log per process and the
 * directory keeps every one, and a per-file watch held a descriptor for each for the app's life (macOS kqueue
 * opens the file; the installed app held 1,131 of them after 3 h). A file keeps only its offset here.
 *
 * A slow 15 s poll is the safety net for a missed or detached directory watch; it lists the directory and reads
 * only the logs written within ACTIVE_MS, so its cost does not grow with the directory. Logs that existed at start
 * are tailed from their end (only new content); a log created after start is read from its first byte. Lines are
 * batched: delivered via onLines at most every 150 ms. Maintains a 1000-line ring buffer.
 */
import { createReadStream, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogBatch } from "../shared/ipc-types";
import { agentDir } from "./agent-paths";

const RING_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 150;
const FALLBACK_POLL_MS = 15_000;
/** A log written within this long is live: the safety poll re-reads it. Older ones wait for a directory event. */
const ACTIVE_MS = 10 * 60_000;

interface LogFile {
	path: string;
	offset: number;
	partial: string;
	/** When this file last grew, as far as this watcher saw (its mtime at start). */
	changedAt: number;
	reading: boolean;
	/** A change arrived while a read ran: read again when it ends. */
	again: boolean;
}

export class LogWatcher {
	#logsDir: string;
	#files = new Map<string, LogFile>();
	#buffer: string[] = [];
	#pending: string[] = [];
	#sequence = 0;
	#flushTimer: NodeJS.Timeout | null = null;
	#pollTimer: NodeJS.Timeout | null = null;
	#dirWatcher: FSWatcher | null = null;
	#running = false;
	/** Set once the first listing finished: a log found after it was created after start and is read whole. */
	#listed = false;

	onLines: ((lines: string[]) => void) | null = null;

	constructor(logsDir?: string) {
		this.#logsDir = logsDir ?? join(agentDir(), "..", "logs");
	}

	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		// Watch first, so a log written while the listing runs is not missed; its event waits for the listing.
		this.#watchDirectory();
		await this.#list();
		if (!this.#running) return;
		this.#listed = true;
		// Safety net only — the directory watch drives the hot path.
		this.#pollTimer = setInterval(() => this.#poll(), FALLBACK_POLL_MS);
	}

	stop(): void {
		this.#running = false;
		this.#listed = false;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#flush();
		this.#dirWatcher?.close();
		this.#dirWatcher = null;
		this.#files.clear();
		this.#buffer = [];
	}

	getBuffer(): string[] {
		return [...this.#buffer];
	}

	getSnapshot(): LogBatch {
		return { lines: this.getBuffer(), nextSequence: this.#sequence };
	}

	/** Lists the directory: tracks logs not seen yet, forgets the ones that are gone. */
	async #list(): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.#logsDir)).filter(name => name.startsWith("omp.") && name.endsWith(".log"));
		} catch {
			return; // Directory may not exist yet; the poll keeps looking.
		}
		if (!this.#running) return;
		const present = new Set(names.map(name => join(this.#logsDir, name)));
		for (const path of this.#files.keys()) if (!present.has(path)) this.#files.delete(path);
		await Promise.all([...present].filter(path => !this.#files.has(path)).map(path => this.#track(path)));
	}

	async #track(path: string): Promise<LogFile | null> {
		const fromStart = this.#listed;
		let size = 0;
		let changedAt = Date.now();
		if (!fromStart) {
			try {
				const fileStat = await stat(path);
				size = fileStat.size;
				changedAt = fileStat.mtimeMs;
			} catch {
				return null;
			}
		}
		if (!this.#running) return null;
		const known = this.#files.get(path);
		if (known) return known;
		const file: LogFile = { path, offset: size, partial: "", changedAt, reading: false, again: false };
		this.#files.set(path, file);
		return file;
	}

	#watchDirectory(): void {
		try {
			const watcher = watch(this.#logsDir, (_eventType, filename) => {
				if (filename === null) {
					this.#poll();
					return;
				}
				if (filename.startsWith("omp.") && filename.endsWith(".log"))
					void this.#changed(join(this.#logsDir, filename));
			});
			watcher.on("error", () => {
				watcher.close();
				if (this.#dirWatcher === watcher) this.#dirWatcher = null;
			});
			this.#dirWatcher = watcher;
		} catch {
			// Logs dir may not exist yet; the poll watches it once it does.
		}
	}

	async #changed(path: string): Promise<void> {
		if (!this.#running || !this.#listed) return; // The first listing reads what is there.
		const file = this.#files.get(path) ?? (await this.#track(path));
		if (file) await this.#read(file);
	}

	#poll(): void {
		if (!this.#running || !this.#listed) return;
		if (!this.#dirWatcher) this.#watchDirectory();
		void this.#list().then(() => {
			const now = Date.now();
			for (const file of this.#files.values()) if (now - file.changedAt < ACTIVE_MS) void this.#read(file);
		});
	}

	async #read(file: LogFile): Promise<void> {
		if (file.reading) {
			file.again = true;
			return;
		}
		file.reading = true;
		try {
			do {
				file.again = false;
				if (!this.#running || this.#files.get(file.path) !== file) return;
				const fileStat = await stat(file.path);
				if (fileStat.size < file.offset) {
					file.offset = 0;
					file.partial = "";
				}
				if (fileStat.size === file.offset) continue;
				const stream = createReadStream(file.path, {
					start: file.offset,
					end: fileStat.size - 1,
					encoding: "utf-8",
				});
				let text = file.partial;
				for await (const chunk of stream) text += chunk;
				if (!this.#running) return;
				const lines = text.split("\n");
				file.partial = lines.pop() ?? "";
				file.offset = fileStat.size;
				file.changedAt = Date.now();
				for (const line of lines) if (line.trim()) this.#pushLine(line);
			} while (file.again);
		} catch {
			// A rotated or temporarily unreadable file is retried by its next event or the poll.
		} finally {
			file.reading = false;
		}
	}

	#pushLine(line: string): void {
		this.#sequence++;
		this.#buffer.push(line);
		if (this.#buffer.length > RING_BUFFER_SIZE) {
			this.#buffer.shift();
		}
		this.#pending.push(line);
		if (!this.#flushTimer) {
			this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_INTERVAL_MS);
		}
	}

	#flush(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		if (this.#pending.length === 0) return;
		const batch = this.#pending;
		this.#pending = [];
		this.onLines?.(batch);
	}
}
