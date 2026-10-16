/**
 * Unsent composer text outlives a renderer reload and an app relaunch. The per-tab composer store
 * lives in memory only (it already rides an omp restart, see tabs.ts), so each draft is also kept in
 * localStorage under its session: the session file (the id while there is none), on its device.
 *
 * A session with no message yet is also filed under its folder: stock writes the session file with
 * the first message, so a relaunch opens a new empty session there and the draft follows it. Only a
 * folder draft written before this page loaded is taken (`since`), so a second new tab in the same
 * folder never copies the draft another open tab is typing, and the first tab to take it claims it.
 *
 * Only the text is kept, folded pastes expanded (their blobs live in memory); pictures are not. The
 * newest {@link MAX_DRAFTS} drafts stay; a sent or cleared draft is dropped at once.
 */

const STORAGE_KEY = "omp.composerDrafts";
const MAX_DRAFTS = 50;

export interface DraftOwner {
	/** Paired host's deviceId; absent = this machine. */
	device?: string;
	sessionFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
	/** No message yet: the session file may not exist after a relaunch. */
	empty: boolean;
}

export interface DraftKeys {
	session: string;
	folder?: string;
}

interface SavedDraft {
	text: string;
	at: number;
	/** A folder draft's session: its own save or send replaces or drops it. */
	session?: string;
}

/** Where a draft is filed; undefined until the session is known. */
export function draftKeys(owner: DraftOwner): DraftKeys | undefined {
	const device = owner.device ?? "local";
	const session = owner.sessionFile || owner.sessionId;
	if (!session) return undefined;
	return {
		session: `${device}|session|${session}`,
		folder: owner.empty && owner.cwd ? `${device}|folder|${owner.cwd}` : undefined,
	};
}

function readAll(storage: Storage): Record<string, SavedDraft> {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const drafts: Record<string, SavedDraft> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== "object" || value === null) continue;
			if (!("text" in value) || typeof value.text !== "string" || !("at" in value) || typeof value.at !== "number")
				continue;
			const session = "session" in value && typeof value.session === "string" ? value.session : undefined;
			drafts[key] = { text: value.text, at: value.at, ...(session === undefined ? {} : { session }) };
		}
		return drafts;
	} catch {
		return {};
	}
}

function writeAll(storage: Storage, drafts: Record<string, SavedDraft>): void {
	const newest = Object.entries(drafts)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, MAX_DRAFTS);
	try {
		if (newest.length === 0) storage.removeItem(STORAGE_KEY);
		else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
	} catch {
		// Storage full or unavailable: the draft stays in memory for this window's life.
	}
}

/** File `text` under its keys; an empty text drops them. A session's earlier folder draft goes either way. */
export function saveDraft(storage: Storage, keys: DraftKeys, text: string, now = Date.now()): void {
	const drafts = readAll(storage);
	for (const [key, saved] of Object.entries(drafts)) if (saved.session === keys.session) delete drafts[key];
	delete drafts[keys.session];
	if (text.trim()) {
		drafts[keys.session] = { text, at: now };
		if (keys.folder !== undefined) drafts[keys.folder] = { text, at: now, session: keys.session };
	}
	writeAll(storage, drafts);
}

/**
 * The session's own draft, else a folder draft written before `since` (claimed: it moves to this
 * session, so no other tab takes it too).
 */
export function loadDraft(storage: Storage, keys: DraftKeys, since: number, now = Date.now()): string | undefined {
	const drafts = readAll(storage);
	const own = drafts[keys.session];
	if (own?.text.trim()) return own.text;
	const folder = keys.folder === undefined ? undefined : drafts[keys.folder];
	if (keys.folder === undefined || !folder?.text.trim() || folder.at >= since) return undefined;
	delete drafts[keys.folder];
	drafts[keys.session] = { text: folder.text, at: now };
	writeAll(storage, drafts);
	return folder.text;
}
