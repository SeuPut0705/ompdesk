/**
 * Contract for GUI-side ("local") RPC commands: commands the GUI renderer sends
 * that stock omp does not implement. The sidecar's dispatcher answers them in
 * the main process instead of forwarding them to omp.
 */

/** The user's installed omp CLI, resolved and version-checked once. */
export interface OmpRuntime {
	/** Absolute path to the omp executable (or `.cmd` shim on Windows). */
	bin: string;
	/** `omp --version` semver, e.g. `18.6.1`. */
	version: string;
	/** Run a short-lived `omp …` subcommand to completion. Never rejects on a non-zero exit; rejects on spawn failure or timeout. */
	run(
		args: string[],
		opts?: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Main-side client of the gui-bridge extension running inside the sidecar. */
export interface BridgeClient {
	/** Call a bridge method; rejects with the bridge's error message, or when disconnected. */
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	/** Subscribe to frames the bridge pushes; returns the unsubscribe. */
	onEvent(cb: (event: { type: string; [k: string]: unknown }) => void): () => void;
	readonly connected: boolean;
}

export interface LocalCommandContext {
	/** The sidecar's current working directory. */
	cwd: string;
	/** Live session file, when the session is persisted. */
	sessionFile?: string;
	omp: OmpRuntime;
	/** Forward to the stock sidecar; resolves with response.data, rejects with Error(response.error). */
	send<T = unknown>(command: { type: string; [k: string]: unknown }): Promise<T>;
	bridge: BridgeClient;
}

/** The returned value becomes `response.data`; a throw becomes `success: false` with the error message. */
export type LocalHandler = (
	command: { type: string; id?: string; [k: string]: unknown },
	ctx: LocalCommandContext,
) => Promise<unknown>;

/** Throw from a handler to fail with a machine-readable `response.code`. */
export class LocalCommandError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "LocalCommandError";
	}
}
