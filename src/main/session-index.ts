/**
 * Watches session JSONL changes for sidebar invalidation. Listing/classification
 * and deletion run stock storage under omp's Bun, without a live tab.
 */
import { existsSync, type FSWatcher, watch } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { codedError } from "../shared/ipc-error-codes";
import type { SessionContentMatch, SessionInfo, SessionKind } from "../shared/ipc-types";
import { agentDir } from "./agent-paths";
import { deletedSessions } from "./deleted-sessions";
import { OmpUnavailableError } from "./omp-availability";
import { StampedLru } from "./session-cache";
import { contentSnippet } from "./session-snippet";
import { StockSessionStore } from "./session-store";

/** Per-file cap for full-content search reads; larger sessions match on this prefix. */
const SEARCH_READ_BYTES = 8 * 1024 * 1024;
/**
 * Total bytes of cached search text. Counted, not entry-counted: one entry can be
 * the full read cap, so an entry-count ceiling alone would allow ~8 MB × entries
 * of resident strings.
 */
const SEARCH_CACHE_BYTES = 64 * 1024 * 1024;
/** Files read concurrently during a content search (bounds FD pressure). */
const SEARCH_BATCH = 16;
/**
 * Session files sit at most three segments below the root: `<project>/<id>.jsonl` and a subagent's
 * `<project>/<session>/<id>.jsonl`. A subagent's own subagents, one level deeper, are not listed.
 */
const SESSION_FILE_SEGMENTS = 3;
/** Project and session directories, whose creation, removal or rename (stock's cwd-encoding migration) moves sessions. */
const SESSION_DIR_SEGMENTS = 2;
/** A path is reported once it has had no event for this long: an agent appends in bursts, and one report a burst is enough. */
const SETTLE_MS = 300;
/** While the sessions root does not exist yet, how often to look for it. */
const ROOT_POLL_MS = 1000;

export class SessionIndex {
	#watcher: FSWatcher | null = null;
	#rootPoll: NodeJS.Timeout | undefined;
	/** Paths with an unsettled event, each with its settle timer. */
	#settling = new Map<string, NodeJS.Timeout>();
	/** `mtime:size` each path had when it was last reported: an event that changed neither (access time) reports nothing. */
	#reported = new Map<string, string>();
	#textCache = new StampedLru<{ raw: string; lower: string }>(
		SEARCH_CACHE_BYTES,
		text => text.raw.length + text.lower.length,
	);
	#sessionsDir: string;
	#cwd: string;
	/** GUI-side chat labels for sessions whose header carries no kind (stock omp writes none). */
	#isChat: (sessionId: string) => boolean;
	#store: StockSessionStore;

	/**
	 * A session file, or a project or session directory, appeared, changed or vanished: called with its path once
	 * its writes settled. Without a path, anything may have changed.
	 */
	onChange: ((path?: string) => void) | null = null;

	constructor(
		sessionsDir: string | undefined,
		cwd: string,
		isChat: (sessionId: string) => boolean = () => false,
		bridgeDir = resolve("resources/gui-bridge"),
	) {
		this.#sessionsDir = sessionsDir ?? join(agentDir(), "sessions");
		this.#cwd = resolve(cwd);
		this.#isChat = isChat;
		this.#store = new StockSessionStore(this.#sessionsDir, bridgeDir);
	}

	/** Sessions root watched by this index (plan files live in per-session artifact dirs beneath it). */
	get sessionsDir(): string {
		return this.#sessionsDir;
	}

	/**
	 * Starts watching: one recursive OS watch of the whole tree (FSEvents on macOS, ReadDirectoryChangesW on Windows).
	 * Never a watch per directory (chokidar's way): libuv's macOS backend keeps one FSEvents stream for all of them
	 * and recreates it, from "now", whenever a watched directory is added or removed, so each new session's artifact
	 * directory dropped the new and removed session files of the whole tree that the old stream had not delivered
	 * yet. The OS starts delivering a moment after this returns; nothing reads that moment, as every reader lists
	 * the sessions when it opens.
	 */
	start(): void {
		let watcher: FSWatcher;
		try {
			watcher = watch(this.#sessionsDir, { recursive: true }, (_event, name) => this.#observe(name));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") this.#awaitRoot();
			else console.warn(`[session-index] not watching ${this.#sessionsDir}: ${error}`);
			return;
		}
		watcher.on("error", error => {
			console.warn(`[session-index] watcher stopped: ${error.message}`);
			watcher.close();
			if (this.#watcher === watcher) this.#watcher = null;
		});
		this.#watcher = watcher;
	}

	/**
	 * No sessions root yet (omp has saved no session): looks for it until it is made, then watches it. A poll, not a
	 * watch of the parent, whose own FSEvents stream could start after the root was made and never report it.
	 */
	#awaitRoot(): void {
		this.#rootPoll = setInterval(() => {
			if (!existsSync(this.#sessionsDir)) return;
			clearInterval(this.#rootPoll);
			this.#rootPoll = undefined;
			this.start();
			// What omp wrote before the watch began is only seen by a fresh list.
			this.#notifyChange();
		}, ROOT_POLL_MS);
	}

	stop(): void {
		this.#watcher?.close();
		this.#watcher = null;
		clearInterval(this.#rootPoll);
		this.#rootPoll = undefined;
		for (const timer of this.#settling.values()) clearTimeout(timer);
		this.#settling.clear();
		this.#reported.clear();
		this.#store.stop();
		this.#textCache.clear();
	}

	/**
	 * @param scope "local" filters to sessions whose cwd matches `cwd`.
	 * @param cwd The calling window's cwd for "local" filtering. Defaults to the
	 *   index's own cwd (single-window behavior); multi-window callers pass their
	 *   own so each window sees only its project's sessions.
	 */
	async list(scope: "local" | "global", cwd?: string): Promise<SessionInfo[]> {
		let parsed: SessionInfo[];
		try {
			parsed = await this.#store.list();
		} catch (error) {
			// No usable omp yet (machine setup is on it): nothing to list, and nothing failed. Main
			// signals a change once omp is usable, and the readers list again.
			if (error instanceof OmpUnavailableError) return [];
			throw error;
		}
		const localCwd = cwd !== undefined ? resolve(cwd) : this.#cwd;
		const deleted = deletedSessions();
		// A file a stray writer put back after its session was deleted is not that session coming back.
		const infos = parsed.filter(info => {
			if (deleted.has(info.path)) return false;
			return scope === "global" || (info.cwd != null && resolve(info.cwd) === localCwd);
		});
		await Promise.all(
			infos.map(async info => {
				if (this.#isChat(info.id) || (await this.#legacyChatKind(info.path))) info.kind = "chat";
			}),
		);
		// Sort by modified descending
		infos.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

		// Dedupe by session id: the agent migrates sessions between legacy and
		// current cwd-directory encodings (e.g. `-AiProject-x` → `home-x-<hash>`),
		// and during that window the same session id can exist as a file in both
		// directories. After the modified-desc sort, the first occurrence of each
		// id is the newest copy — keep it and drop the stale duplicates so one
		// session never renders as two sidebar rows.
		const seen = new Set<string>();
		return infos.filter(info => {
			if (!info.id || seen.has(info.id)) return false;
			seen.add(info.id);
			return true;
		});
	}

	/** GUI chat labels are an overlay: stock sessions have no chat-kind concept. */
	async kindFor(sessionPath: string): Promise<SessionKind> {
		try {
			const infos = await this.#store.listDirectory(sessionPath);
			const info = infos.find(row => resolve(row.path) === resolve(sessionPath));
			return info && (this.#isChat(info.id) || (await this.#legacyChatKind(sessionPath))) ? "chat" : "agent";
		} catch {
			return "agent";
		}
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		await this.#store.delete(target);
		this.#textCache.delete(target);
		this.#notifyChange();
	}

	/** Move a stored session to another project folder (stock `SessionManager.moveTo`); returns its new path. */
	async moveSession(sessionPath: string, cwd: string): Promise<string> {
		const source = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!source.startsWith(root) || !source.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		const target = resolve(cwd);
		const info = await stat(target).catch(() => null);
		if (!info?.isDirectory()) throw codedError("not_a_directory", `Not a directory: ${target}`);
		const moved = await this.#store.move(source, target);
		this.#textCache.delete(source);
		this.#textCache.delete(moved);
		this.#notifyChange();
		return moved;
	}

	/**
	 * Full-content search: the given session files whose raw JSONL text
	 * contains every query token (case-insensitive), each with an excerpt of
	 * the conversation around the first token. The match is deliberately a raw
	 * grep — no JSON parsing — because tokens are matched individually, so JSON
	 * escaping rarely breaks them. File text is cached by mtime:size so
	 * debounced keystrokes only re-read files that changed.
	 */
	async searchContent(query: string, candidatePaths: string[]): Promise<SessionContentMatch[]> {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0 || candidatePaths.length === 0) return [];
		const matches: SessionContentMatch[] = [];
		for (let i = 0; i < candidatePaths.length; i += SEARCH_BATCH) {
			const batch = await Promise.all(
				candidatePaths.slice(i, i + SEARCH_BATCH).map(async (path): Promise<SessionContentMatch | null> => {
					const text = await this.#searchText(path);
					if (text === null) return null;
					for (const token of tokens) {
						if (!text.lower.includes(token)) return null;
					}
					const snippet = contentSnippet(text.raw, text.lower, tokens);
					return snippet === undefined ? { path } : { path, snippet };
				}),
			);
			for (const hit of batch) {
				if (hit !== null) matches.push(hit);
			}
		}
		return matches;
	}

	/** Session-file text and its lowercase twin (capped at SEARCH_READ_BYTES), LRU-cached by mtime:size. */
	async #searchText(filePath: string): Promise<{ raw: string; lower: string } | null> {
		try {
			const fileStat = await stat(filePath);
			const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
			const cached = this.#textCache.get(filePath, signature);
			if (cached !== null) return cached;
			const fh = await open(filePath, "r");
			try {
				const length = Math.min(fileStat.size, SEARCH_READ_BYTES);
				const buffer = Buffer.alloc(length);
				await fh.read(buffer, 0, length, 0);
				const raw = buffer.toString("utf-8");
				const text = { raw, lower: raw.toLowerCase() };
				this.#textCache.set(filePath, signature, text);
				return text;
			} finally {
				await fh.close();
			}
		} catch {
			return null;
		}
	}

	/**
	 * One raw watch event. A session file at most three segments down, or a non-hidden entry at most two down (a
	 * project or session directory appearing, vanishing or renamed; hidden entries there are stock's lock and
	 * staging files), is reported once it settles. Anything else (tool output, plans) is not looked at.
	 */
	#observe(name: string | null): void {
		if (name === null) {
			// The OS gave up on naming what changed (a Windows buffer overflow): anything may have.
			this.#notifyChange();
			return;
		}
		const segments = name.split(/[\\/]/);
		const base = segments[segments.length - 1];
		const watched = base.endsWith(".jsonl")
			? segments.length <= SESSION_FILE_SEGMENTS
			: segments.length <= SESSION_DIR_SEGMENTS && base !== "" && !base.startsWith(".");
		if (!watched) return;
		const path = join(this.#sessionsDir, name);
		clearTimeout(this.#settling.get(path));
		this.#settling.set(
			path,
			setTimeout(() => {
				this.#settling.delete(path);
				void this.#settle(path);
			}, SETTLE_MS),
		);
	}

	/**
	 * Reports a settled path unless it still has the `mtime:size` it was last reported with; a session file's
	 * cached text goes with it. Each event names its path, so nothing else is stat'ed: an agent streaming into one
	 * file never walks the tree.
	 */
	async #settle(path: string): Promise<void> {
		const session = path.endsWith(".jsonl");
		let signature: string | null = null;
		try {
			const info = await lstat(path);
			// Beside the session files only directories move sessions; any other file there is not one.
			if (!session && !info.isDirectory()) return;
			signature = `${info.mtimeMs}:${info.size}`;
		} catch {
			/* Gone: deleted, or renamed away with the sessions in it. */
		}
		if (this.#watcher === null) return;
		if (signature === null) this.#reported.delete(path);
		else if (this.#reported.get(path) === signature) return;
		else this.#reported.set(path, signature);
		if (session) this.#textCache.delete(path);
		this.#notifyChange(path);
	}

	/** Legacy GUI-only header flag; stock session-listing deliberately does not expose it.
	 * Read only this presentation overlay, never derive stock metadata or lifecycle.
	 */
	async #legacyChatKind(filePath: string): Promise<boolean> {
		try {
			const fh = await open(filePath, "r");
			try {
				const buffer = Buffer.alloc(4096);
				const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
				for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
					try {
						const entry = JSON.parse(line) as { type?: string; kind?: string };
						if (entry.type === "session") return entry.kind === "chat";
					} catch {
						/* A partial final line is not a header. */
					}
				}
			} finally {
				await fh.close();
			}
		} catch {
			/* Missing/unreadable files have no GUI label. */
		}
		return false;
	}

	#notifyChange(path?: string): void {
		this.onChange?.(path);
	}
}
