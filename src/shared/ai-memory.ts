/**
 * ai-memory (https://github.com/akitaonrails/ai-memory, MIT) is OMPdesk's memory: a release binary shipped inside
 * the app (`resources/ai-memory-bin/`, pinned by `resources/omp-builtin/ai-memory/ai-memory.json`), wired into omp
 * by ai-memory's own installer (`setup --agent omp`: MCP entry, the generated omp extension, skills) and served by
 * ai-memory's own per-user service (launchd on macOS, a logon entry on Windows). Main side: src/main/ai-memory/.
 * Stock omp's own memory backends are never used and have no Settings rows.
 */
import pin from "../../resources/omp-builtin/ai-memory/ai-memory.json" with { type: "json" };

/** Settings › Memory (ai-memory) switch. Default on: only a stored `false` turns it off. */
export const AI_MEMORY_PREF = "aiMemory";
/** The version the app ships (the pin file is the only place it is written). */
export const AI_MEMORY_VERSION: string = pin.version;
/** The pin file's per-platform assets, keyed `<process.platform>-<process.arch>`. */
export const AI_MEMORY_ASSETS: Record<string, { archive: string; archiveSha256: string; binary: string; binarySha256: string }> =
	pin.assets;

export function aiMemoryEnabled(value: unknown): boolean {
	return value !== false;
}

/**
 * - `off`: switched off (hooks, MCP entry and skills removed, the service stopped).
 * - `starting`: on, and main is staging the binary, wiring omp or starting the server (`step` says which).
 * - `ready`: wired, and the server answers.
 * - `unreachable`: wired, but the server does not answer (stopped, crashed, port taken); main retries on its own.
 * - `failed`: staging or wiring failed (`detail`); retried at the next launch or by Settings › Try again.
 * - `unsupported`: no build for this platform.
 */
export type AiMemoryPhase = "off" | "starting" | "ready" | "unreachable" | "failed" | "unsupported";

export type AiMemoryStep = "stage" | "wire" | "unwire" | "purge" | "check";

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
	/** What is on disk for omp right now (read from the files, not remembered). */
	wiring: { extension: boolean; mcp: boolean };
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
	/** Search hits only. */
	snippet?: string;
}

export interface AiMemoryHandoff extends AiMemoryProjectRef {
	id: string;
	agent: string;
	createdAt: string | null;
	/** The handoff body's first lines (what the next session is told). */
	summary: string;
}

export interface AiMemoryPage extends AiMemoryPageRef {
	markdown: string;
}
