/**
 * This machine's automatic setup (src/main/setup/): what OMPdesk needs on the
 * computer it runs on, what it is doing about it, and why an install failed.
 * Main owns every decision and command; the renderer only shows this state and
 * may ask for a retry or a cancel by item id (never a command).
 *
 * Required: Bun and omp everywhere, plus Git for Windows on Windows (stock
 * omp's shell tools resolve Git Bash there). Optional: Git (macOS), GitHub CLI
 * and Node.js (the built-in REA MCP server).
 */

/** Display and install order: Bun before omp (omp installs through it), Git before omp on Windows. */
export const SETUP_ITEMS = ["bun", "git", "omp", "gh", "node"] as const;
export type SetupItemId = (typeof SETUP_ITEMS)[number];

export function isSetupItemId(value: unknown): value is SetupItemId {
	return typeof value === "string" && (SETUP_ITEMS as readonly string[]).includes(value);
}

/** Whether `item` is required on `platform`: Bun and omp everywhere, Git only on Windows. */
export function setupItemRequired(item: SetupItemId, platform: SetupPlatform): boolean {
	return item === "bun" || item === "omp" || (item === "git" && platform === "win32");
}

export type SetupPlatform = "darwin" | "win32" | "other";

/** What detection found. `path` is the executable (or install root) it found. */
export type SetupPresence =
	| { kind: "present"; version: string | null; path: string | null }
	| { kind: "missing" }
	| { kind: "outdated"; version: string; minimum: string; path: string | null }
	| { kind: "broken"; detail: string; path: string | null };

/** How main installs an item on this machine. */
export type SetupMethod =
	| "bun-script"
	| "bun-global"
	| "omp-update"
	| "portable-git"
	| "xcode-select"
	| "brew"
	| "winget"
	| "archive";

/**
 * - `checking`: detection has not finished yet.
 * - `present`: installed and usable; nothing to do.
 * - `queued` / `running`: an install is waiting / running.
 * - `failed` / `cancelled`: the last install ended that way (`failure` says why).
 * - `requested`: the OS took over (the macOS Xcode tools dialog); detected again on the next check.
 * - `unavailable`: no way to install it automatically here (`manualUrl` has the download page).
 * - `backoff`: missing, but recent automatic attempts kept failing; it waits for a retry or a later launch.
 * - `idle`: missing and not attempted yet in this launch (automatic setup is off, e.g. in tests).
 */
export type SetupItemPhase =
	| "checking"
	| "present"
	| "queued"
	| "running"
	| "failed"
	| "cancelled"
	| "requested"
	| "unavailable"
	| "backoff"
	| "idle";

/**
 * - `exit`: the installer exited non-zero (`exitCode`).
 * - `spawn`: the installer could not be started (`detail`).
 * - `not-detected`: it finished, but the item is still not found.
 * - `download`: a download or release lookup failed (`detail`).
 * - `checksum`: the download did not match its published SHA-256.
 * - `prerequisite`: an item it needs is missing (omp without Bun).
 */
export type SetupFailureReason = "exit" | "spawn" | "not-detected" | "download" | "checksum" | "prerequisite";

export interface SetupFailure {
	reason: SetupFailureReason;
	exitCode?: number | null;
	detail?: string;
}

/** Bytes of a download main runs itself; `total` is the size the server announced, null when it announced none. */
export interface SetupDownloadProgress {
	received: number;
	total: number | null;
}

/** How far a running install got. */
export interface SetupProgress {
	/** This item's place in the install run it belongs to (1-based), and how many items that run installs. */
	step: number;
	steps: number;
	/** When this item's install started (ms since the epoch, main's clock). */
	startedAt: number;
	/** While main downloads the item's file; null once its installer runs, or when it downloads nothing itself. */
	download: SetupDownloadProgress | null;
}

export interface SetupItemState {
	id: SetupItemId;
	required: boolean;
	phase: SetupItemPhase;
	/** null until the first detection finished. */
	presence: SetupPresence | null;
	method: SetupMethod | null;
	/** The exact command main runs (or ran) for this item; null when there is none. */
	command: string | null;
	/** Where it installs. */
	location: string | null;
	/** `uac`: Windows asks for permission; `dialog`: macOS shows its own installer dialog. */
	prompt: "uac" | "dialog" | null;
	/** Set while `phase` is `running`, null otherwise. */
	progress: SetupProgress | null;
	/** Installer output so far (stdout and stderr, ANSI kept), the last SETUP_OUTPUT_TAIL characters. */
	output: string;
	failure: SetupFailure | null;
	/** What to run by hand when the automatic install keeps failing. */
	manualCommands: string[];
	/** Official download/instructions page. */
	manualUrl: string;
}

export interface SetupState {
	platform: SetupPlatform;
	/** False when this launch never installs on its own (tests, dev builds); detection still runs. */
	automatic: boolean;
	/** omp is found and new enough: sidecars can start. */
	ompReady: boolean;
	/** The required items' install is queued or running. */
	requiredRunning: boolean;
	items: SetupItemState[];
}

export const SETUP_OUTPUT_TAIL = 64 * 1024;
