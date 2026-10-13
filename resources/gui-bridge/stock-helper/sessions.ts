import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The fields of stock's `SessionInfo` this helper reads; the rest pass through untouched. */
interface StockSessionInfo {
	path: string;
	size: number;
	modified: Date | string;
	firstMessage: string;
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

/** Stock session-listing's placeholder when its bounded prefix scan finds no first prompt. */
const NO_MESSAGES = "(no messages)";
/** Most bytes streamed to find a first prompt (stock's own header read bound). */
const FIRST_PROMPT_READ_LIMIT = 1024 * 1024;
/** First prompts found past stock's prefix window, keyed by path, valid for one `modified:size` stamp. */
const firstPrompts = new Map<string, { stamp: string; text: string }>();

/**
 * Stock lists a session's first prompt from a 4 KB prefix only. Anything stock
 * persists before it, e.g. the xd:// device inventory notice that an MCP server
 * with many tools (the built-in REA has ~170) makes tens of KB long, hides the
 * prompt, and the row reads "(no messages)". Stream the journal with stock's
 * loader up to the first user message and take its text the way the listing does.
 */
async function withFirstPrompts(rows: StockSessionInfo[]): Promise<StockSessionInfo[]> {
	if (!rows.some(row => row.firstMessage === NO_MESSAGES)) return rows;
	firstPromptLoaded ??= loadStockFirstPrompt();
	const stock = await firstPromptLoaded;
	if (!stock) return rows;
	await Promise.all(
		rows.map(async row => {
			if (row.firstMessage !== NO_MESSAGES) return;
			const stamp = `${new Date(row.modified).getTime()}:${row.size}`;
			const cached = firstPrompts.get(row.path);
			if (cached?.stamp === stamp) {
				if (cached.text) row.firstMessage = cached.text;
				return;
			}
			let text = "";
			try {
				await stock.visitEntriesFromFileStream(
					row.path,
					entry => {
						if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message")
							return undefined;
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
			firstPrompts.set(row.path, { stamp, text });
			if (text) row.firstMessage = text;
		}),
	);
	return rows;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"sessions.list": async params => {
		const { sessionsRoot } = paths(params);
		const { listing, storage } = await stockSessions();
		const rows = await withFirstPrompts(await listing.listAllSessions(storage, sessionsRoot));
		const listed = new Set(rows.map(row => row.path));
		for (const path of firstPrompts.keys()) if (!listed.has(path)) firstPrompts.delete(path);
		return rows;
	},
	"sessions.list_directory": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { listing, storage } = await stockSessions();
		return withFirstPrompts(await listing.listSessionsReadOnly(dirname(sessionPath), storage));
	},
	"sessions.delete": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { storage } = await stockSessions();
		await storage.deleteSessionWithArtifacts(sessionPath);
		return null;
	},
};
