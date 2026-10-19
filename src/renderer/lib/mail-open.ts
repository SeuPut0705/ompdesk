/**
 * Which session reports (`ompdesk.mail` lines in the transcript) the person opened or closed, by report id. Kept in
 * memory for remounts (virtualized rows, tab switches) and in `sessionStorage` so a reload keeps it; newest
 * `MAIL_OPEN_LIMIT` entries only. A report nobody toggled follows its kind's default (`MailNote`).
 */
const STORAGE_KEY = "omp.mailOpen";
export const MAIL_OPEN_LIMIT = 300;

let cache: Map<string, boolean> | null = null;

function storage(): Storage | undefined {
	try {
		return globalThis.sessionStorage;
	} catch {
		return undefined;
	}
}

function load(): Map<string, boolean> {
	if (cache) return cache;
	cache = new Map();
	try {
		const raw = storage()?.getItem(STORAGE_KEY);
		const entries: unknown = raw ? JSON.parse(raw) : [];
		if (Array.isArray(entries))
			for (const entry of entries)
				if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "boolean")
					cache.set(entry[0], entry[1]);
	} catch {
		// A damaged entry only costs the remembered toggles.
	}
	return cache;
}

export function rememberedMailOpen(id: string): boolean | undefined {
	return load().get(id);
}

export function rememberMailOpen(id: string, open: boolean): void {
	const map = load();
	map.delete(id);
	map.set(id, open);
	while (map.size > MAIL_OPEN_LIMIT) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	try {
		storage()?.setItem(STORAGE_KEY, JSON.stringify([...map]));
	} catch {
		// Full or unavailable storage: memory still holds it for this page.
	}
}

export function resetMailOpenForTest(): void {
	cache = null;
}
