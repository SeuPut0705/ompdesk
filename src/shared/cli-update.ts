/**
 * The command-line tools of connected accounts, kept current (src/main/cli-tools/): for each provider with
 * a stored credential, its vendor's CLI (Claude Code, Codex, Gemini CLI, Cursor Agent, GitHub CLI and its
 * Copilot), plus the tools machine setup installs (GitHub CLI, Node.js in the managed tools dir). OMPdesk only
 * updates a CLI that is already installed, through the method that owns it (its own updater, npm or Bun
 * global, Homebrew, winget, or the managed tools dir), never one it would have to install, never with sudo,
 * and never a system-owned or app-bundled copy. Each computer updates its own tools; a paired host does its own.
 * The renderer shows this state and may ask for "Update now" by tool id; it never names a command or a path.
 */

/** Display order. */
export const CLI_TOOLS = ["claude", "codex", "gemini", "cursor-agent", "copilot", "gh", "gh-copilot", "node"] as const;
export type CliToolId = (typeof CLI_TOOLS)[number];

export function isCliToolId(value: unknown): value is CliToolId {
	return typeof value === "string" && (CLI_TOOLS as readonly string[]).includes(value);
}

/** Product names: never translated. */
export const CLI_TOOL_NAMES: Record<CliToolId, string> = {
	claude: "Claude Code",
	codex: "Codex CLI",
	gemini: "Gemini CLI",
	"cursor-agent": "Cursor Agent",
	copilot: "GitHub Copilot CLI",
	gh: "GitHub CLI",
	"gh-copilot": "GitHub Copilot (gh extension)",
	node: "Node.js",
};

/**
 * How a tool is updated here.
 * - `self`: its own updater (`claude update`, `cursor-agent update`, `gh extension upgrade gh-copilot`).
 * - `npm` / `bun`: a global package, updated by the npm or Bun that owns its prefix.
 * - `brew` / `brew-cask`: a Homebrew formula or cask (`brew upgrade [--cask] <name>`).
 * - `winget`: a winget package (`winget upgrade --id <id>`).
 * - `managed`: the copy machine setup put into `<tools>` (its verified release archive again).
 */
export type CliUpdateMethod = "self" | "npm" | "bun" | "brew" | "brew-cask" | "winget" | "managed";

/**
 * Why OMPdesk leaves an installed tool alone.
 * - `system`: the OS owns it (/usr/bin, the Xcode Command Line Tools).
 * - `bundled`: another app ships it inside its bundle (e.g. Codex in ChatGPT.app); that app updates it.
 * - `not-writable`: its install dir needs admin rights; OMPdesk never uses sudo.
 * - `unknown-install`: installed some way OMPdesk cannot update (a version manager, a manual copy).
 */
export type CliSkipReason = "system" | "bundled" | "not-writable" | "unknown-install";

/**
 * - `check`: looking up the newest version failed (`detail`).
 * - `install`: the update exited non-zero or could not start (`detail`: its last lines).
 * - `not-updated`: it finished, but the tool still reports the old version.
 * - `cancelled`: stopped from This computer, or by quitting.
 */
export type CliUpdateFailureReason = "check" | "install" | "not-updated" | "cancelled";

export interface CliUpdateFailure {
	reason: CliUpdateFailureReason;
	detail?: string;
}

/**
 * The last check's outcome. `deferred`: a newer version exists, but the tool was running and its update would
 * replace the package files that process still loads; it is tried again at the next check.
 */
export type CliUpdateResult =
	| { kind: "current" }
	| { kind: "updated"; from: string | null; to: string }
	| { kind: "deferred"; latest: string }
	| { kind: "failed"; failure: CliUpdateFailure };

export interface CliToolState {
	id: CliToolId;
	/** Connected providers that use this tool (stock ids, e.g. `anthropic`); empty for a machine-setup tool. */
	providers: string[];
	/** The version installed now; null when it could not be read. */
	installed: string | null;
	/** Where it was found (the resolved executable). */
	path: string | null;
	/** How OMPdesk updates it; null when skipped. */
	method: CliUpdateMethod | null;
	skip: CliSkipReason | null;
	phase: "idle" | "checking" | "updating";
	/** The newest version as of the last check; null before one, or when only the tool's own updater knows. */
	latest: string | null;
	checkedAt: number | null;
	last: CliUpdateResult | null;
}

export interface CliUpdateState {
	/** The pref: whether scheduled checks may update. "Update now" works either way. */
	enabled: boolean;
	/** This launch checks on a timer (packaged app, or a test launch that opts in). */
	scheduled: boolean;
	/** Installed tools only, in CLI_TOOLS order. */
	tools: CliToolState[];
}
