/**
 * Watches session JSONL changes for sidebar invalidation. Listing/classification
 * and deletion run stock storage under omp's Bun, without a live tab.
 */
import { open, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { codedError } from "../shared/ipc-error-codes";
import type { SessionInfo, SessionKind } from "../shared/ipc-types";
import { agentDir } from "./agent-paths";
import { StampedLru } from "./session-cache";
import { type SessionStore, StockSessionStore } from "./session-store";

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

export class SessionIndex {
	#watcher: FSWatcher | null = null;
	#textCache = new StampedLru<string>(SEARCH_CACHE_BYTES, text => text.length);
	#sessionsDir: string;
	#cwd: string;
	/** GUI-side chat labels for sessions whose header carries no kind (stock omp writes none). */
	#isChat: (sessionId: string) => boolean;
	#store: SessionStore;

	onChange: (() => void) | null = null;

	constructor(
		sessionsDir: string | undefined,
		cwd: string,
		isChat: (sessionId: string) => boolean = () => false,
		store?: SessionStore,
		bridgeDir = resolve("resources/gui-bridge"),
	) {
		this.#sessionsDir = sessionsDir ?? join(agentDir(), "sessions");
		this.#cwd = resolve(cwd);
		this.#isChat = isChat;
		this.#store = store ?? new StockSessionStore(this.#sessionsDir, bridgeDir);
	}

	/** Sessions root watched by this index (plan files live in per-session artifact dirs beneath it). */
	get sessionsDir(): string {
		return this.#sessionsDir;
	}

	start(): void {
		this.#watcher = watch(this.#sessionsDir, {
			persistent: true,
			ignoreInitial: false,
			depth: 2,
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
		});

		// add/change/unlink all mean the same thing here: this one file's cached
		// view is dead. The event carries the path, so nothing else is touched.
		this.#watcher.on("add", path => this.#invalidate(path));
		this.#watcher.on("change", path => this.#invalidate(path));
		this.#watcher.on("unlink", path => this.#invalidate(path));
	}

	stop(): void {
		this.#watcher?.close();
		this.#watcher = null;
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
		const parsed = await this.#store.list();
		const localCwd = cwd !== undefined ? resolve(cwd) : this.#cwd;
		const infos = parsed.filter(info => {
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

	/**
	 * Full-content search: paths of the given session files whose raw JSONL
	 * text contains every query token (case-insensitive). Deliberately a raw
	 * grep — no JSON parsing — because tokens are matched individually, so
	 * JSON escaping rarely breaks them. Lowercased file text is cached by
	 * mtime:size so debounced keystrokes only re-read files that changed.
	 */
	async searchContent(query: string, candidatePaths: string[]): Promise<string[]> {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0 || candidatePaths.length === 0) return [];
		const matches: string[] = [];
		for (let i = 0; i < candidatePaths.length; i += SEARCH_BATCH) {
			const batch = await Promise.all(
				candidatePaths.slice(i, i + SEARCH_BATCH).map(async path => {
					const text = await this.#searchText(path);
					if (text === null) return null;
					for (const token of tokens) {
						if (!text.includes(token)) return null;
					}
					return path;
				}),
			);
			for (const hit of batch) {
				if (hit !== null) matches.push(hit);
			}
		}
		return matches;
	}

	/** Lowercased session-file text (capped at SEARCH_READ_BYTES), LRU-cached by mtime:size. */
	async #searchText(filePath: string): Promise<string | null> {
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
				const text = buffer.toString("utf-8").toLowerCase();
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
	 * One session file changed, appeared, or vanished: forget exactly that file's
	 * cached view and notify. Nothing else is stat'ed — the previous handler
	 * re-fingerprinted every session in the tree on each event, so an agent
	 * streaming into one file walked the whole directory repeatedly.
	 */
	#invalidate(path: string): void {
		if (!path.endsWith(".jsonl")) return;
		this.#textCache.delete(path);
		this.#notifyChange();
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

	#notifyChange(): void {
		this.onChange?.();
	}
}
