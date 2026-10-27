import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PROMPT_ORIGIN_ENTRY } from "../prompt-origin-contracts";
import { NO_TEXT_PROMPT } from "../session-list-contracts";
import { lastActivity } from "./session-activity";

/** The fields of stock's `SessionInfo` this helper reads; the rest pass through untouched. */
interface StockSessionInfo {
	path: string;
	size: number;
	modified: Date | string;
	firstMessage: string;
	/** OMPdesk's: the paired device the first prompt came from (stock's journal holds OMPdesk's prompt-origin entry). */
	promptOriginDevice?: string;
}

interface StockSessions {
	listing: {
		listAllSessions(storage: unknown, root: string): Promise<StockSessionInfo[]>;
		listSessionsReadOnly(directory: string, storage: unknown): Promise<StockSessionInfo[]>;
	};
	storage: { deleteSessionWithArtifacts(sessionPath: string): Promise<void> };
}

/** Stock modules for the first-prompt fill; loaded only once a row needs it. */
interface StockFirstPrompt {
	visitEntriesFromFileStream(
		filePath: string,
		visit: (entry: unknown) => boolean | undefined,
		options: { maxBytes: number },
	): Promise<unknown>;
	/** Stock's message text projection (the one its session listing uses). */
	textContent(content: string | readonly unknown[], separator: string): string;
}

/** The stock SessionManager surface `sessions.move` uses. */
interface StockSessionManagerStatic {
	open(
		filePath: string,
		sessionDir: undefined,
		storage: undefined,
		options: { throwIfMissing: boolean },
	): Promise<{ moveTo(cwd: string): Promise<void>; getSessionFile(): string | undefined; close(): Promise<void> }>;
}

/** Runtime-selected installed paths: static imports would use the app's resolver. */
function importFromOmp(specifier: string): Promise<Record<string, unknown>> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is not set");
	return import(Bun.resolveSync(specifier, join(root, "package.json")));
}

async function loadStockSessions(): Promise<StockSessions> {
	const [listing, storageModule] = await Promise.all([
		importFromOmp("@oh-my-pi/pi-coding-agent/session/session-listing"),
		importFromOmp("@oh-my-pi/pi-coding-agent/session/session-storage"),
	]);
	const FileSessionStorage = storageModule.FileSessionStorage as new () => StockSessions["storage"];
	return { listing: listing as unknown as StockSessions["listing"], storage: new FileSessionStorage() };
}

async function loadStockFirstPrompt(): Promise<StockFirstPrompt | null> {
	try {
		const [loader, transcript] = await Promise.all([
			importFromOmp("@oh-my-pi/pi-coding-agent/session/session-loader"),
			importFromOmp("@oh-my-pi/pi-tui/chat/transcript-entry"),
		]);
		const { visitEntriesFromFileStream } = loader;
		const { textContent } = transcript;
		if (typeof visitEntriesFromFileStream !== "function" || typeof textContent !== "function")
			throw new Error("stock session-loader/transcript-entry exports changed");
		return {
			visitEntriesFromFileStream: visitEntriesFromFileStream as StockFirstPrompt["visitEntriesFromFileStream"],
			textContent: textContent as StockFirstPrompt["textContent"],
		};
	} catch (error) {
		// Best-effort fill: listing keeps stock's rows. Logged once (stderr), no session data.
		console.error(`stock-helper: first-prompt fill unavailable: ${error instanceof Error ? error.message : error}`);
		return null;
	}
}

let loaded: Promise<StockSessions> | undefined;
function stockSessions(): Promise<StockSessions> {
	loaded ??= loadStockSessions();
	return loaded;
}
let firstPromptLoaded: Promise<StockFirstPrompt | null> | undefined;

function paths(params: unknown): { sessionsRoot: string; sessionPath?: string } {
	if (
		typeof params !== "object" ||
		params === null ||
		!("sessionsRoot" in params) ||
		typeof params.sessionsRoot !== "string" ||
		!isAbsolute(params.sessionsRoot)
	)
		throw new Error("Invalid sessions root");
	const sessionsRoot = resolve(params.sessionsRoot);
	if (!("sessionPath" in params)) return { sessionsRoot };
	if (typeof params.sessionPath !== "string" || !isAbsolute(params.sessionPath))
		throw new Error("Invalid session path");
	const sessionPath = resolve(params.sessionPath);
	if (!sessionPath.startsWith(`${sessionsRoot}${sep}`) || !sessionPath.endsWith(".jsonl"))
		throw new Error("Invalid session path");
	return { sessionsRoot, sessionPath };
}

/**
 * The session id in a journal's header (stock keys the ownership lease by it); undefined when unreadable. Read as
 * stock's `readSessionHeaderIdSync` does: a 64 KB prefix, past the fixed-width title slot stock writes first
 * (`parseTitleSlotFromContent`, session-title-slot), then the header line.
 */
async function sessionHeaderId(sessionPath: string): Promise<string | undefined> {
	let prefix = await Bun.file(sessionPath)
		.slice(0, 64 * 1024)
		.text()
		.catch(() => "");
	const slots = await importFromOmp("@oh-my-pi/pi-coding-agent/session/session-title-slot").catch(() => null);
	const parseSlot = slots?.parseTitleSlotFromContent;
	if (typeof parseSlot !== "function") throw new Error("stock session-title-slot exports changed");
	if ((parseSlot as (content: string) => unknown)(prefix)) prefix = prefix.slice(prefix.indexOf("\n") + 1);
	const end = prefix.indexOf("\n");
	if (end === -1) return undefined;
	try {
		const entry: unknown = JSON.parse(prefix.slice(0, end));
		if (typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session" && "id" in entry)
			return typeof entry.id === "string" ? entry.id : undefined;
	} catch {}
	return undefined;
}

/** Stock session-listing's placeholder when its bounded prefix scan finds no first prompt. */
const NO_MESSAGES = "(no messages)";
/** First message of a session that has conversation but no prompt text (e.g. an image-only prompt). */
const NO_TEXT_LABEL = NO_TEXT_PROMPT;
/** Most bytes streamed to find a first prompt (stock's own header read bound). */
const FIRST_PROMPT_READ_LIMIT = 1024 * 1024;
/** Journal entries stock writes around a session that are not conversation (header, settings, hidden notices). */
const HEADER_ENTRY_TYPES = new Set([
	"title",
	"session",
	"thinking_level_change",
	"service_tier_change",
	"model_change",
	"custom",
	"custom_message",
]);
/**
 * What a scanned row resolves to, keyed by path, valid for one `modified:size` stamp: the first prompt ("" for a
 * file read to its end without one, null to keep stock's), and the device that prompt came from.
 */
const firstPrompts = new Map<string, { stamp: string; firstMessage: string | null; origin: string | undefined }>();
/** A first prompt that is another session's agent brief (`wrapAgentMessage`): the opener may be on another device. */
const AGENT_BRIEF = "<ompdesk-agent-message ";

/**
 * Stock lists a session's first prompt from a 4 KB prefix only. Anything stock
 * persists before it, e.g. the xd:// device inventory notice an MCP server with
 * many tools writes, hides the prompt, and the row reads "(no messages)". Stream
 * the journal with stock's loader up to the first user message and take its text
 * the way the listing does. A file read to its end without one is a header-only
 * session (stock writes one when a chat is deleted and the next one starts):
 * its first message becomes "", so the sidebar treats it as empty instead of
 * listing the English placeholder as a conversation that comes back after every delete.
 * A row whose first prompt is an agent brief is streamed too, for the prompt-origin entry journaled in front of
 * that prompt: a session a paired device's agent opened here has its opener on that device, not in this list.
 */
async function withFirstPrompts(rows: StockSessionInfo[]): Promise<StockSessionInfo[]> {
	const scanned = (row: StockSessionInfo) =>
		row.firstMessage === NO_MESSAGES || row.firstMessage.startsWith(AGENT_BRIEF);
	if (!rows.some(scanned)) return rows;
	firstPromptLoaded ??= loadStockFirstPrompt();
	const stock = await firstPromptLoaded;
	if (!stock) return rows;
	await Promise.all(
		rows.map(async row => {
			if (!scanned(row)) return;
			const stamp = `${new Date(row.modified).getTime()}:${row.size}`;
			const apply = (found: { firstMessage: string | null; origin: string | undefined }) => {
				if (found.firstMessage !== null && row.firstMessage === NO_MESSAGES) row.firstMessage = found.firstMessage;
				if (found.origin) row.promptOriginDevice = found.origin;
			};
			const cached = firstPrompts.get(row.path);
			if (cached?.stamp === stamp) return apply(cached);
			let text = "";
			let origin: string | undefined;
			// Only a journal of header/settings entries is an empty session. A message of any role
			// (an image-only prompt has no text), a shown custom message or an unknown entry type
			// is conversation: stock's messageCount comes from the same 4 KB prefix, so clearing such
			// a row would hide a real session.
			let conversation = false;
			try {
				await stock.visitEntriesFromFileStream(
					row.path,
					entry => {
						if (typeof entry !== "object" || entry === null || !("type" in entry)) {
							conversation = true;
							return undefined;
						}
						if (entry.type !== "message") {
							if (
								entry.type === "custom" &&
								"customType" in entry &&
								entry.customType === PROMPT_ORIGIN_ENTRY &&
								"data" in entry &&
								typeof entry.data === "object" &&
								entry.data !== null &&
								"deviceId" in entry.data &&
								typeof entry.data.deviceId === "string"
							)
								origin = entry.data.deviceId;
							if (!HEADER_ENTRY_TYPES.has(String(entry.type))) conversation = true;
							else if (entry.type === "custom_message" && !("display" in entry && entry.display === false))
								conversation = true;
							return undefined;
						}
						conversation = true;
						if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null)
							return undefined;
						const message = entry.message;
						if (!("role" in message) || message.role !== "user" || !("content" in message)) return undefined;
						const content = message.content;
						if (typeof content !== "string" && !Array.isArray(content)) return undefined;
						text = stock.textContent(content, " ");
						return text ? false : undefined;
					},
					{ maxBytes: FIRST_PROMPT_READ_LIMIT },
				);
			} catch {
				// Unreadable now (stock's own scan skips such files too): keep stock's row.
				return;
			}
			// No text but conversation (an image-only prompt) or too large to tell: label it so it stays listed;
			// only a header-only file read to its end is empty.
			const firstMessage = text || (!conversation && row.size <= FIRST_PROMPT_READ_LIMIT ? "" : NO_TEXT_LABEL);
			const found = { stamp, firstMessage, origin };
			firstPrompts.set(row.path, found);
			apply(found);
		}),
	);
	return rows;
}

/** The placeholder never crosses the wire: a row whose prompt could not be read has no first message. */
function withoutPlaceholder(rows: StockSessionInfo[]): StockSessionInfo[] {
	for (const row of rows) if (row.firstMessage === NO_MESSAGES) row.firstMessage = "";
	return rows;
}

/** Each row's newest message time, keyed by path and valid for one `modified:size` stamp (null: none in reach). */
const activity = new Map<string, { stamp: string; at: number | null }>();

/**
 * A row's `modified` becomes when the session last did something (`session-activity.ts`): stock's mtime moves on
 * every relaunch (a `session_exit`, a recap, a report) and every reader of `modified` means recency (the sidebar's
 * age and order, the session picker, the projects' recency). A row with no message in reach keeps stock's mtime.
 */
async function withLastActivity(rows: StockSessionInfo[]): Promise<StockSessionInfo[]> {
	await Promise.all(
		rows.map(async row => {
			const stamp = `${new Date(row.modified).getTime()}:${row.size}`;
			let found = activity.get(row.path);
			if (found?.stamp !== stamp) {
				try {
					found = { stamp, at: await lastActivity(row.path, row.size) };
				} catch {
					// Unreadable now (stock's own scan skips such files too): keep stock's mtime.
					return;
				}
				activity.set(row.path, found);
			}
			if (found.at !== null) row.modified = new Date(found.at);
		}),
	);
	return rows;
}

/** Read-only probes the stock worker answers at once, beside its serial queue (`createDispatcher`): a restored tab's
 * omp spawns only after `sessions.owned` answers, and queued behind launch's session-list scan it waited ~0.3–0.5 s
 * for the scan, not the lease. The probe takes the lease for an instant and touches no journal. */
export const UNQUEUED_METHODS: Readonly<Record<string, true>> = { "sessions.owned": true };

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"sessions.list": async params => {
		const { sessionsRoot } = paths(params);
		const { listing, storage } = await stockSessions();
		const rows = await withLastActivity(await withFirstPrompts(await listing.listAllSessions(storage, sessionsRoot)));
		const listed = new Set(rows.map(row => row.path));
		for (const path of firstPrompts.keys()) if (!listed.has(path)) firstPrompts.delete(path);
		for (const path of activity.keys()) if (!listed.has(path)) activity.delete(path);
		return withoutPlaceholder(rows);
	},
	"sessions.list_directory": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { listing, storage } = await stockSessions();
		return withoutPlaceholder(
			await withLastActivity(
				await withFirstPrompts(await listing.listSessionsReadOnly(dirname(sessionPath), storage)),
			),
		);
	},
	/** Stock `deleteSessionWithArtifacts`; like stock's own `dropSession`, a file already gone (a tab's session never written) counts as deleted. */
	"sessions.delete": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { storage } = await stockSessions();
		try {
			await storage.deleteSessionWithArtifacts(sessionPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		return null;
	},
	/**
	 * Move a stored session (no live tab holds it) to another project folder:
	 * stock `SessionManager.moveTo`, the same relocation `/move` runs, artifacts
	 * included. Stock refuses while another live omp writes the session.
	 */
	"sessions.move": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const cwd = typeof params === "object" && params !== null && "cwd" in params ? params.cwd : undefined;
		if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Invalid target folder");
		const { SessionManager } = (await importFromOmp("@oh-my-pi/pi-coding-agent/session/session-manager")) as {
			SessionManager: StockSessionManagerStatic;
		};
		const manager = await SessionManager.open(sessionPath, undefined, undefined, { throwIfMissing: true });
		try {
			await manager.moveTo(resolve(cwd));
			return { sessionPath: manager.getSessionFile() ?? sessionPath };
		} finally {
			await manager.close();
		}
	},
	/**
	 * Whether another live omp process owns the session (stock's ownership lease, `tryAcquireSessionLease`, keyed by
	 * the journal header's id). An omp that opens a session owned elsewhere moves it to a new file, so main waits for
	 * the owner to let go before it starts one on it (an update's relaunch while the last launch's omp still exits).
	 * Probing takes the lease for an instant and releases it before answering.
	 */
	"sessions.owned": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const id = await sessionHeaderId(sessionPath);
		if (!id) return false;
		const storage = await importFromOmp("@oh-my-pi/pi-coding-agent/session/session-storage");
		const tryAcquire = storage.tryAcquireSessionLease;
		if (typeof tryAcquire !== "function") return false;
		const lease = (tryAcquire as (sessionId: string) => { release(): void } | null)(id);
		if (!lease) return true;
		lease.release();
		return false;
	},
	/**
	 * A stored session's transcript, read-only: stock `loadSessionMessagesReadOnly` (no writer, no lock, safe against a
	 * file a live omp writes), the messages along the persisted leaf. The control tools' `ompdesk_session_read` pages it.
	 */
	"sessions.messages": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const loader = await importFromOmp("@oh-my-pi/pi-coding-agent/session/session-loader");
		const read = loader.loadSessionMessagesReadOnly;
		if (typeof read !== "function")
			throw new Error("This omp cannot read stored sessions (loadSessionMessagesReadOnly).");
		return (await (read as (path: string) => Promise<unknown[]>)(sessionPath)) ?? [];
	},
};
