/**
 * ai-memory (https://github.com/akitaonrails/ai-memory, MIT) is OMPdesk's memory: a release binary shipped inside
 * the app (`resources/ai-memory-bin/`, pinned by `resources/omp-builtin/ai-memory/ai-memory.json`), served by
 * ai-memory's own per-user service (launchd on macOS, a logon entry on Windows) and loaded into the omp sessions
 * OMPdesk spawns through an app-owned extension root (`<userData>/ai-memory/omp-ext/`, passed with `-e`: the omp
 * extension, MCP entry and skills ai-memory's own generators write). Nothing is written to the user's
 * `~/.omp/agent` unless they press "Also use in the terminal omp". Main side: src/main/ai-memory/.
 * Stock omp's own memory backends are never used and have no Settings rows.
 */
import pin from "../../resources/omp-builtin/ai-memory/ai-memory.json" with { type: "json" };

/** Settings › Memory (ai-memory) switch. Default on: only a stored `false` turns it off. */
export const AI_MEMORY_PREF = "aiMemory";
/**
 * Whether the user connected their plain terminal `omp` too (`true`), disconnected it (`false`), or never decided
 * (absent). The first launch with an absent value moves the global wiring an earlier build wrote (ai-memory's
 * extension and MCP entry in omp's agent dir, run from OMPdesk's staged binary) to the app-owned root and stores `false`.
 */
export const AI_MEMORY_TERMINAL_PREF = "aiMemoryTerminal";
/** `true` while OMPdesk itself installed ai-memory's user service and may stop it; `false` once a service it did not start was found. */
export const AI_MEMORY_SERVICE_OWNED_PREF = "aiMemoryServiceOwned";
/** The version the app ships (the pin file is the only place it is written). */
export const AI_MEMORY_VERSION: string = pin.version;
/** The pin file's per-platform assets, keyed `<process.platform>-<process.arch>`. */
export const AI_MEMORY_ASSETS: Record<
	string,
	{ archive: string; archiveSha256: string; binary: string; binarySha256: string }
> = pin.assets;

export function aiMemoryEnabled(value: unknown): boolean {
	return value !== false;
}

/**
 * - `off`: switched off (OMPdesk stopped loading it; the server stopped when OMPdesk started it and nothing else uses it).
 * - `starting`: on, and main is staging the binary, generating the extension root or starting the server (`step` says which).
 * - `ready`: connected, and the server answers.
 * - `unreachable`: connected, but the server does not answer (stopped, crashed, port taken); main retries on its own.
 * - `failed`: staging or setup failed (`detail`); retried at the next launch or by Settings › Try again.
 * - `unsupported`: no build for this platform.
 */
export type AiMemoryPhase = "off" | "starting" | "ready" | "unreachable" | "failed" | "unsupported";

export type AiMemoryStep = "stage" | "wire" | "unwire" | "purge" | "check" | "terminal";

export interface AiMemoryState {
	enabled: boolean;
	phase: AiMemoryPhase;
	step: AiMemoryStep | null;
	/** The binary in use: the app's own copy, or the user's own install when it is newer (never older). */
	source: "bundled" | "external";
	/** Version of the binary in use (null until known). */
	version: string | null;
	/** The binary wiring points at (null while unknown). */
	binary: string | null;
	/** ai-memory's data directory (wiki, db, raw, token) — null until `setup --plan --json` has told. */
	dataDir: string | null;
	/** `http://127.0.0.1:49374` (its configured server URL). */
	serverUrl: string | null;
	/** The server's /web console. */
	webUrl: string | null;
	/**
	 * What is on disk right now (read from the files, not remembered). `app`: OMPdesk's own extension root is complete.
	 * `terminal`: ai-memory's wiring sits in omp's agent dir, so the plain `omp` CLI uses it too (the user's choice, or
	 * their own `ai-memory setup`); OMPdesk then does not load its root as well, so a session never captures twice.
	 */
	wiring: { app: boolean; terminal: boolean };
	/** From the server's /admin/status; null while it does not answer. */
	stats: { pages: number; sessions: number; observations: number; diskBytes: number } | null;
	detail: string | null;
}

export interface AiMemoryProjectRef {
	workspace: string;
	project: string;
}

export interface AiMemoryProject extends AiMemoryProjectRef {
	pages: number;
	lastUpdated: string | null;
}

export interface AiMemoryPageRef extends AiMemoryProjectRef {
	/** Wiki path (`sessions/<id>.md`, `decisions/0007-db.md`). */
	path: string;
	title: string;
	updatedAt: string | null;
	/** `rule`, `decision`, `gotcha`, `procedure`, `session`, `note`, `concept`, `slot` or `fact` (ai-memory's own contract). */
	kind?: string;
	/** `working`, `episodic`, `semantic` or `procedural`. */
	tier?: string | null;
	/** Search hits only. */
	snippet?: string;
}

/** The kinds the Pages list groups by, in display order. */
export const AI_MEMORY_KINDS = ["rule", "decision", "gotcha", "procedure", "session", "note"] as const;
export type AiMemoryKind = (typeof AI_MEMORY_KINDS)[number];

export interface AiMemoryHandoff extends AiMemoryProjectRef {
	id: string;
	agent: string;
	createdAt: string | null;
	/** The handoff body's first lines (what the next session is told). */
	summary: string;
	openQuestions: string[];
	nextSteps: string[];
	/** `open` (waiting for the next session in that folder), `accepted`, or another state ai-memory reports. */
	state: string;
}

export interface AiMemoryPage extends AiMemoryPageRef {
	markdown: string;
	/** The latest version's id; changes with every write. */
	id: string;
	pinned: boolean;
	createdAt: string | null;
	tags: string[];
}

/** One project's counts and health, from the server's overview. Null fields: the server did not say. */
export interface AiMemoryOverview {
	pages: number;
	sessions: number;
	observations: number;
	lastCaptureAt: string | null;
	openHandoffs: number;
	activity7d: { sessions: number; observations: number; pagesUpdated: number };
	health: { stale: number; duplicates: number; contradictions: number; orphans: number };
}

export interface AiMemorySession {
	id: string;
	cwd: string;
	agent: string;
	startedAt: string | null;
	endedAt: string | null;
	observations: number;
	/** The consolidation job's state (`pending`, `running`, `completed`, `failed`, `superseded`), or null. */
	consolidation: string | null;
}

export interface AiMemoryObservation {
	id: string;
	kind: string;
	title: string;
	body: string;
	createdAt: string | null;
}

export interface AiMemoryObservations {
	session: AiMemorySession;
	observations: AiMemoryObservation[];
	total: number;
	offset: number;
}

export interface AiMemoryProfileEntry {
	path: string;
	category: string;
	statement: string;
	appliesTo: string[];
	enforcedBy: string | null;
}

/** The cross-project profile every session starts with. `scope` is the project holding its pages (null: none yet). */
export interface AiMemoryProfile {
	enabled: boolean;
	injected: boolean;
	digestBytes: number;
	scope: AiMemoryProjectRef | null;
	entries: AiMemoryProfileEntry[];
}

export interface AiMemoryLintFinding {
	kind: string;
	severity: string;
	message: string;
	pages: string[];
}

/** What the retention sweep evicted (or, on a dry run, would). */
export interface AiMemorySweep {
	dryRun: boolean;
	evaluated: number;
	evicted: number;
	compacted: number;
	merged: number;
	expired: number;
	observationsPruned: number;
}

/** A page deleted from the Pages list: `rev` is the checkpoint that still holds it, which Restore reads it back from. */
export interface AiMemoryDeleted extends AiMemoryProjectRef {
	path: string;
	title: string;
	rev: string;
	deletedAt: string;
}

export type AiMemoryFeedback = "helpful" | "not_helpful";

export interface AiMemoryWriteInput extends AiMemoryProjectRef {
	path: string;
	body: string;
	title?: string;
	kind?: string;
	tier?: string;
	tags?: string[];
	pinned?: boolean;
}
