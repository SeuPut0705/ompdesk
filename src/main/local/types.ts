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

/**
 * Where one bridge request spent its time (epoch ms on this machine's clock; the bridge runs on the same one).
 * `receivedAt`/`loadMs`/`bridgeMs` are absent when no reply came (yet), or from a bridge older than the field.
 */
export interface BridgeTiming {
	/** Waiting for the bridge socket to connect before the request could go out. */
	connectWaitMs: number;
	sentAt: number;
	/** When omp's event loop got to the request: `receivedAt - sentAt` is time omp was busy with other work. */
	receivedAt?: number;
	/** The bridge waiting for its area modules to load (stock imports at omp startup). */
	loadMs?: number;
	/** The method itself (the stock call). */
	bridgeMs?: number;
	/** When the reply (or the disconnect) reached main. */
	answeredAt?: number;
}

/** Main-side client of the gui-bridge extension running inside the sidecar. */
export interface BridgeClient {
	/**
	 * Call a bridge method; rejects with the bridge's error message, or when disconnected. `onTiming` gets the
	 * timing when the request goes out and again, completed, when it settles.
	 */
	request<T = unknown>(method: string, params?: unknown, onTiming?: (timing: BridgeTiming) => void): Promise<T>;
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
	/** The sidecar this command runs in: when its omp was spawned, and how long building this context waited on it. */
	sidecar?: { spawnedAt: number; contextWaitMs: number };
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
