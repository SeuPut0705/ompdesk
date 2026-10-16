/**
 * The vendor CLIs OMPdesk keeps current, and which connected providers make each one relevant. A tool's
 * install method comes from where its executable resolves (detect.ts); this table only says what the tool
 * is and what its own updater is. Stock provider ids are pi-ai's (`registry/oauth/*`).
 */
import type { CliToolId } from "../../shared/cli-update";

export interface CliToolSpec {
	/** Executable name (Windows also tries `.exe` and `.cmd`). */
	bin: string;
	/** Stock provider ids whose stored credential makes this tool relevant. */
	providers: readonly string[];
	/** A tool machine setup installs (src/main/setup/): listed whenever it is installed, connected or not. */
	setup?: boolean;
	/**
	 * Its own updater (run with the tool's executable). `registry`: OMPdesk asks npm for `npm`'s latest
	 * first and runs the updater only when that is newer; `self`: the updater checks by itself (no-op when
	 * current), so OMPdesk compares the version before and after.
	 */
	self?: { args: readonly string[]; checks: "registry" | "self" };
	/** Its npm package (the registry the `registry` check asks). */
	npm?: string;
	/** Its winget id (Windows). */
	winget?: string;
	/** Machine setup's archive for it (`managed`: updated only when it lives in the managed tools dir). */
	managed?: "gh" | "node";
	/** Only the managed copy counts: a system or version-manager copy of it is the user's, never listed. */
	managedOnly?: boolean;
	/**
	 * A running process of it loads files from its package dir after start (a Node CLI): an update that
	 * replaces that dir (npm, Bun, Homebrew) waits until no process of it runs.
	 */
	lazyLoads: boolean;
}

export const CLI_TOOL_SPECS: Record<CliToolId, CliToolSpec> = {
	claude: {
		bin: "claude",
		providers: ["anthropic"],
		self: { args: ["update"], checks: "registry" },
		npm: "@anthropic-ai/claude-code",
		lazyLoads: true,
	},
	codex: { bin: "codex", providers: ["openai-codex", "openai"], npm: "@openai/codex", lazyLoads: true },
	gemini: {
		bin: "gemini",
		providers: ["google-gemini-cli", "google"],
		npm: "@google/gemini-cli",
		lazyLoads: true,
	},
	"cursor-agent": {
		bin: "cursor-agent",
		providers: ["cursor"],
		self: { args: ["update"], checks: "self" },
		lazyLoads: false,
	},
	copilot: { bin: "copilot", providers: ["github-copilot"], npm: "@github/copilot", lazyLoads: true },
	gh: { bin: "gh", providers: ["github-copilot"], setup: true, winget: "GitHub.cli", managed: "gh", lazyLoads: false },
	// Detected through gh (`gh extension list`), updated by `gh extension upgrade gh-copilot`.
	"gh-copilot": {
		bin: "gh",
		providers: ["github-copilot"],
		self: { args: ["extension", "upgrade", "gh-copilot"], checks: "self" },
		lazyLoads: false,
	},
	node: { bin: "node", providers: [], setup: true, managed: "node", managedOnly: true, lazyLoads: false },
};

/** The tools a set of connected providers (and machine setup) makes relevant, in display order. */
export function relevantTools(connected: Iterable<string>, order: readonly CliToolId[]): Map<CliToolId, string[]> {
	const providers = new Set(connected);
	const relevant = new Map<CliToolId, string[]>();
	for (const id of order) {
		const spec = CLI_TOOL_SPECS[id];
		const using = spec.providers.filter(provider => providers.has(provider));
		if (spec.setup || using.length > 0) relevant.set(id, using);
	}
	return relevant;
}
