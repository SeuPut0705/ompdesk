/**
 * Last-known-state snapshots: small, versioned, bounded copies of what the last session showed (the tab list, the
 * sidebar index, a session's newest transcript page, usage, the model list) that the next start renders at once
 * and then revalidates in place. localStorage on both surfaces: it is synchronous, so the first React render can
 * read it (the desktop's lives in the profile under userData, the phone's in the page's origin).
 *
 * Rules (AGENTS.md › No loading screens, pinned by `snapshot-cache.test.ts`):
 * - One key per `kind` × namespace × key, `omp.snap.<VERSION>.…`; a different `SNAPSHOT_VERSION` never reads (and
 *   `pruneStale` deletes) the older generation, so a shape change needs no migration.
 * - Namespace = whose data it is: `local` (this computer's own omp) or `device:<id>` (a paired host's tabs
 *   shown on this window). Another host's snapshot is never read as this one's, and `clearNamespace` forgets one.
 * - Bounded: an entry holds at most `ENTRY_MAX_CHARS`, each kind keeps its newest `kindLimit` entries, the whole
 *   cache `TOTAL_MAX_CHARS`; the least recently written goes first, and a full storage evicts and retries once.
 * - Private: only `scrub`bed values are stored. Keys that name a credential are dropped, token-shaped strings are
 *   replaced and inline image bytes are not kept; nothing here ever holds a login, a key or a pairing secret.
 * - Never authoritative: a reader treats a snapshot as the guess to paint, and the live read replaces it.
 */

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KINDS = ["shell", "tabs", "sessions", "transcript", "usage", "models", "panel"] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

const PREFIX = "omp.snap.";
const INDEX_KEY = `${PREFIX}${SNAPSHOT_VERSION}.index`;
/** One entry's serialized size; a bigger value is not stored (the transcript trimmer cuts to this first). */
export const ENTRY_MAX_CHARS = 240_000;
/** Everything the cache holds. localStorage gives a page about 5 M UTF-16 units; this leaves the app's own keys room. */
export const TOTAL_MAX_CHARS = 1_800_000;
/** Entries kept per kind, newest first. */
export const KIND_LIMITS: Record<SnapshotKind, number> = {
	shell: 2,
	tabs: 4,
	sessions: 6,
	transcript: 8,
	usage: 4,
	models: 4,
	/** A panel or page's last read (Stats, ai-memory): small, per host, read at the page's first frame. */
	panel: 64,
};
/** A snapshot older than this is not shown as the last known state (a month-old guess is a lie, not a hint). */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SnapshotStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

interface Stored<T> {
	v: number;
	at: number;
	d: T;
}

type IndexEntry = [at: number, chars: number];
type Index = Record<string, IndexEntry>;

export interface SnapshotRead<T> {
	value: T;
	/** When it was written (ms since the epoch); a reader may show a quiet "updating" hint while it is old. */
	at: number;
}

const CREDENTIAL_KEY =
	/token|secret|passw(or)?d|authorization|api[-_]?key|cookie|credential|private[-_]?key|bearer|signature/i;
const SECRET_SHAPES: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const REDACTED = "[redacted]";
const MAX_DEPTH = 24;

/** A deep copy without anything credential-shaped. Pure: the input is never changed. */
export function scrub<T>(value: T): T {
	return scrubValue(value, 0) as T;
}

function scrubString(text: string): string {
	let out = text;
	for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
	return out;
}

function scrubValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return scrubString(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return undefined;
	if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	const isImage = record.type === "image";
	for (const [key, item] of Object.entries(record)) {
		if (CREDENTIAL_KEY.test(key)) continue;
		// Picture bytes are the largest thing a transcript carries and are re-read with the live page.
		if (isImage && key === "data") continue;
		const next = scrubValue(item, depth + 1);
		if (next !== undefined) out[key] = next;
	}
	return out;
}

const keyOf = (kind: SnapshotKind, ns: string, key: string): string =>
	`${PREFIX}${SNAPSHOT_VERSION}.${kind}.${encodeURIComponent(ns)}.${encodeURIComponent(key)}`;

const kindOfKey = (storageKey: string): SnapshotKind | null => {
	const rest = storageKey.slice(`${PREFIX}${SNAPSHOT_VERSION}.`.length);
	const kind = rest.slice(0, rest.indexOf("."));
	return (SNAPSHOT_KINDS as readonly string[]).includes(kind) ? (kind as SnapshotKind) : null;
};

export interface SnapshotCacheOptions {
	storage: SnapshotStorage | null;
	now?: () => number;
}

export interface SnapshotCache {
	read<T>(kind: SnapshotKind, ns: string, key: string, maxAgeMs?: number): SnapshotRead<T> | null;
	/** Scrubs, bounds and stores `value`; false when it was not kept (too big, no storage, storage full twice). */
	write<T>(kind: SnapshotKind, ns: string, key: string, value: T): boolean;
	remove(kind: SnapshotKind, ns: string, key: string): void;
	/** Forget everything of one namespace (an unpaired or blocked host, a signed-out device). */
	clearNamespace(ns: string): void;
	clearAll(): void;
	/** Delete entries of any other `SNAPSHOT_VERSION` and anything older than the max age. */
	pruneStale(): void;
	/** Serialized size of what is stored now (tests, diagnostics). */
	totalChars(): number;
}

export function createSnapshotCache({ storage, now = Date.now }: SnapshotCacheOptions): SnapshotCache {
	let index: Index | null = null;

	const readIndex = (): Index => {
		if (index) return index;
		index = {};
		if (!storage) return index;
		try {
			const raw = storage.getItem(INDEX_KEY);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				index = parsed as Index;
				return index;
			}
		} catch {
			// A corrupt index is rebuilt below.
		}
		index = rebuild();
		return index;
	};

	const rebuild = (): Index => {
		const rebuilt: Index = {};
		if (!storage) return rebuilt;
		const own = `${PREFIX}${SNAPSHOT_VERSION}.`;
		for (let i = 0; i < storage.length; i++) {
			const storageKey = storage.key(i);
			if (!storageKey?.startsWith(own) || storageKey === INDEX_KEY) continue;
			const raw = storage.getItem(storageKey);
			if (raw === null) continue;
			let at = 0;
			try {
				at = Number((JSON.parse(raw) as Stored<unknown>).at) || 0;
			} catch {
				// Unreadable: it sorts as the oldest and goes first.
			}
			rebuilt[storageKey] = [at, raw.length];
		}
		return rebuilt;
	};

	const saveIndex = () => {
		if (!storage || !index) return;
		try {
			storage.setItem(INDEX_KEY, JSON.stringify(index));
		} catch {
			// The index is advisory: a lost write is rebuilt from the entries on the next cold read.
		}
	};

	const drop = (storageKey: string) => {
		try {
			storage?.removeItem(storageKey);
		} catch {
			// Nothing to do.
		}
		delete readIndex()[storageKey];
	};

	const total = (): number => Object.values(readIndex()).reduce((sum, entry) => sum + entry[1], 0);

	/** Oldest first, optionally only one kind's. */
	const oldest = (kind?: SnapshotKind): string[] =>
		Object.entries(readIndex())
			.filter(([storageKey]) => kind === undefined || kindOfKey(storageKey) === kind)
			.sort((a, b) => a[1][0] - b[1][0])
			.map(([storageKey]) => storageKey);

	const evictTo = (kind: SnapshotKind, kindLimit: number, room: number) => {
		const ofKind = oldest(kind);
		while (ofKind.length > kindLimit) drop(ofKind.shift() as string);
		while (total() + room > TOTAL_MAX_CHARS) {
			const next = oldest()[0];
			if (next === undefined) break;
			drop(next);
		}
	};

	return {
		read<T>(kind: SnapshotKind, ns: string, key: string, maxAgeMs = SNAPSHOT_MAX_AGE_MS): SnapshotRead<T> | null {
			if (!storage) return null;
			const storageKey = keyOf(kind, ns, key);
			try {
				const raw = storage.getItem(storageKey);
				if (raw === null) return null;
				const stored = JSON.parse(raw) as Stored<T>;
				if (stored.v !== SNAPSHOT_VERSION || now() - stored.at > maxAgeMs || stored.at > now() + 60_000) {
					drop(storageKey);
					saveIndex();
					return null;
				}
				return { value: stored.d, at: stored.at };
			} catch {
				drop(storageKey);
				return null;
			}
		},

		write<T>(kind: SnapshotKind, ns: string, key: string, value: T): boolean {
			if (!storage) return false;
			let raw: string;
			try {
				raw = JSON.stringify({ v: SNAPSHOT_VERSION, at: now(), d: scrub(value) } satisfies Stored<T>);
			} catch {
				return false;
			}
			if (raw.length > ENTRY_MAX_CHARS) return false;
			const storageKey = keyOf(kind, ns, key);
			const entries = readIndex();
			delete entries[storageKey];
			evictTo(kind, KIND_LIMITS[kind] - 1, raw.length);
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					storage.setItem(storageKey, raw);
					entries[storageKey] = [now(), raw.length];
					saveIndex();
					return true;
				} catch {
					// Quota: let the oldest entry go and try once more.
					const next = oldest()[0];
					if (next === undefined) break;
					drop(next);
				}
			}
			saveIndex();
			return false;
		},

		remove(kind, ns, key) {
			drop(keyOf(kind, ns, key));
			saveIndex();
		},

		clearNamespace(ns) {
			const marker = `.${encodeURIComponent(ns)}.`;
			for (const storageKey of Object.keys(readIndex())) {
				const rest = storageKey.slice(`${PREFIX}${SNAPSHOT_VERSION}.`.length);
				if (rest.slice(rest.indexOf(".")).startsWith(marker)) drop(storageKey);
			}
			saveIndex();
		},

		clearAll() {
			for (const storageKey of Object.keys(readIndex())) drop(storageKey);
			saveIndex();
		},

		pruneStale() {
			if (!storage) return;
			const current = `${PREFIX}${SNAPSHOT_VERSION}.`;
			const doomed: string[] = [];
			for (let i = 0; i < storage.length; i++) {
				const storageKey = storage.key(i);
				if (storageKey?.startsWith(PREFIX) && !storageKey.startsWith(current)) doomed.push(storageKey);
			}
			for (const storageKey of doomed) storage.removeItem(storageKey);
			const cutoff = now() - SNAPSHOT_MAX_AGE_MS;
			for (const [storageKey, [at]] of Object.entries(readIndex())) if (at < cutoff) drop(storageKey);
			saveIndex();
		},

		totalChars: total,
	};
}

function browserStorage(): SnapshotStorage | null {
	try {
		// Safari private mode and a locked-down profile throw on access.
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

let shared: SnapshotCache | null = null;

/** The page's one cache over localStorage (null storage: every read misses and every write is refused). */
export function snapshots(): SnapshotCache {
	shared ??= createSnapshotCache({ storage: browserStorage() });
	return shared;
}

/** Tests: drop the memoized cache so the next `snapshots()` reads the current `localStorage`. */
export function resetSnapshotsForTest(): void {
	shared = null;
}

/** Namespace of data from this computer's omp (`local`) or a paired host's device. */
export const snapshotNs = (device?: string | null): string => (device ? `device:${device}` : "local");

/** Writes are coalesced to one per key per `delayMs`, off the render path (a stream appends every few ms). */
export function createDeferredWriter(
	cache: () => SnapshotCache,
	schedule: (run: () => void) => () => void,
): <T>(kind: SnapshotKind, ns: string, key: string, produce: () => T) => void {
	const pending = new Map<string, () => void>();
	return (kind, ns, key, produce) => {
		const id = `${kind}\u0000${ns}\u0000${key}`;
		if (pending.has(id)) return;
		const cancel = schedule(() => {
			pending.delete(id);
			cache().write(kind, ns, key, produce());
		});
		pending.set(id, cancel);
	};
}
