import { dirname, isAbsolute, join, resolve, sep } from "node:path";

interface StockSessions {
	listing: {
		listAllSessions(storage: unknown, root: string): Promise<unknown>;
		listSessionsReadOnly(directory: string, storage: unknown): Promise<unknown>;
	};
	storage: { deleteSessionWithArtifacts(sessionPath: string): Promise<void> };
}

async function loadStockSessions(): Promise<StockSessions> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is not set");
	// Runtime-selected installed paths: static imports would use the app's resolver.
	const fromOmp = (specifier: string) => Bun.resolveSync(specifier, join(root, "package.json"));
	const [listing, storageModule] = await Promise.all([
		import(fromOmp("@oh-my-pi/pi-coding-agent/session/session-listing")),
		import(fromOmp("@oh-my-pi/pi-coding-agent/session/session-storage")),
	]);
	return { listing, storage: new storageModule.FileSessionStorage() };
}

let loaded: Promise<StockSessions> | undefined;
function stockSessions(): Promise<StockSessions> {
	return loaded ??= loadStockSessions();
}

function paths(params: unknown): { sessionsRoot: string; sessionPath?: string } {
	if (typeof params !== "object" || params === null || !("sessionsRoot" in params) || typeof params.sessionsRoot !== "string" || !isAbsolute(params.sessionsRoot))
		throw new Error("Invalid sessions root");
	const sessionsRoot = resolve(params.sessionsRoot);
	if (!("sessionPath" in params)) return { sessionsRoot };
	if (typeof params.sessionPath !== "string" || !isAbsolute(params.sessionPath)) throw new Error("Invalid session path");
	const sessionPath = resolve(params.sessionPath);
	if (!sessionPath.startsWith(`${sessionsRoot}${sep}`) || !sessionPath.endsWith(".jsonl")) throw new Error("Invalid session path");
	return { sessionsRoot, sessionPath };
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"sessions.list": async params => {
		const { sessionsRoot } = paths(params);
		const { listing, storage } = await stockSessions();
		return listing.listAllSessions(storage, sessionsRoot);
	},
	"sessions.list_directory": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { listing, storage } = await stockSessions();
		return listing.listSessionsReadOnly(dirname(sessionPath), storage);
	},
	"sessions.delete": async params => {
		const { sessionPath } = paths(params);
		if (!sessionPath) throw new Error("Invalid session path");
		const { storage } = await stockSessions();
		await storage.deleteSessionWithArtifacts(sessionPath);
		return null;
	},
};
