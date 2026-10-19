/**
 * ai-memory (https://github.com/akitaonrails/ai-memory, MIT) is OMPdesk's memory: built from the source vendored in
 * `native/memory/` (`bun run build:memory`) and shipped inside the app (`resources/ai-memory-bin/`), served by
 * ai-memory's own per-user service (launchd on macOS, a logon entry on Windows) and loaded into the omp sessions
 * OMPdesk spawns through an app-owned extension root (`<userData>/ai-memory/omp-ext/`, passed with `-e`: the omp
 * extension, MCP entry and skills ai-memory's own generators write). Nothing is written to the user's
 * `~/.omp/agent` unless they press "Also use in the terminal omp". Main side: src/main/ai-memory/.
 * Stock omp's own memory backends are never used and have no Settings rows.
 */
import source from "../../native/memory/ompdesk.json" with { type: "json" };

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
/** The ai-memory version the app builds and ships (`native/memory/ompdesk.json`, equal to its Cargo workspace version). */
export const AI_MEMORY_VERSION: string = source.version;
/** The shipped binary's file name per `<process.platform>-<process.arch>`: the two builds OMPdesk makes. */
export const AI_MEMORY_BINARIES: Record<string, string> = { "darwin-arm64": "ai-memory", "win32-x64": "ai-memory.exe" };
/** The build record `bun run build:memory` writes next to the binary (`{ binary, binarySha256, ... }`). */
export const AI_MEMORY_BUILD_MANIFEST = "ai-memory.build.json";

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
	/** Search hits only. */
	snippet?: string;
}

export interface AiMemoryHandoff extends AiMemoryProjectRef {
	id: string;
	agent: string;
	createdAt: string | null;
	/** The handoff body's first lines (what the next session is told). */
	summary: string;
	/** `open` (waiting for the next session in that folder), `accepted`, or another state ai-memory reports. */
	state: string;
}

export interface AiMemoryPage extends AiMemoryPageRef {
	markdown: string;
}
