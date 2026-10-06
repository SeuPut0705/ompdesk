/**
 * Launch profiles: per-workspace agent CLI customisation configured in the
 * GUI (Settings → Launch Profile), persisted in GUI prefs under
 * `launchProfiles.<cwd>`, and appended to the sidecar spawn argv by
 * src/main/sidecar.ts. This module is pure mapping/preview — no I/O — so the
 * renderer (settings form + effective-command preview) and the main process
 * (spawn) share one source of truth.
 *
 * Flag mappings mirror packages/coding-agent/src/cli/flag-tables.ts.
 */

export interface LaunchProfile {
	/** --system-prompt <text>: full system prompt override. */
	systemPrompt?: string;
	/** --append-system-prompt <text>: appended to the default system prompt. */
	appendSystemPrompt?: string;
	/** --no-rules: skip rules files. */
	noRules?: boolean;
	/** --add-dir <path> (repeated): extra directories the agent may touch. */
	addDirs?: string[];
	/** --tools <csv>: tool whitelist (comma-separated, agent normalizes names). */
	tools?: string[];
	/** --no-lsp: disable LSP tooling. */
	noLsp?: boolean;
	/** --plan-yolo: auto-approve plan-mode execution. */
	planYolo?: boolean;
	/** --profile <name>: agent profile to boot from. */
	profile?: string;
	/** --session-dir <path>: where session files live. */
	sessionDir?: string;
	/** --config <path>: config file path. */
	config?: string;
}

/**
 * Flags the GUI/sidecar owns — session continuity (--session/--resume), the
 * rpc-ui transport (--mode), print/export plumbing, cwd, and process chrome —
 * plus credential-bearing flags that must stay in the protected provider
 * configuration flow. A launch profile must never override them: any of these
 * found in profile-sourced flags is dropped (value token included).
 */
export const DENYLISTED_FLAGS: readonly string[] = [
	"--session",
	"--mode",
	"--print",
	"--print-thoughts",
	"--export",
	"--cwd",
	"--resume",
	"--fork",
	"--help",
	"--version",
	"--no-pty",
	"--no-title",
	"--api-key",
	"--no-tools",
];

const DENYLISTED: Record<string, true> = {
	"--session": true,
	"--mode": true,
	"--print": true,
	"--print-thoughts": true,
	"--export": true,
	"--cwd": true,
	"--resume": true,
	"--fork": true,
	"--help": true,
	"--version": true,
	"--no-pty": true,
	"--no-title": true,
	"--api-key": true,
	"--no-tools": true,
};

/** Denylisted flags that consume a separate value token (--flag value). The
 * rest are boolean switches; --resume/--session take an optional value and
 * are treated as value-taking so a smuggled value never survives as a stray
 * positional argument. */
const DENYLISTED_WITH_VALUE: Record<string, true> = {
	"--session": true,
	"--mode": true,
	"--export": true,
	"--cwd": true,
	"--resume": true,
	"--fork": true,
	"--api-key": true,
};

/** Non-denylisted flags that consume a separate value token. The value of one
 * of these is DATA (a prompt, a path, a tool list) and must never be inspected
 * as a potential smuggled flag — a prompt that happens to be "--session" is a
 * legitimate value, not an override. */
const VALUED_FLAGS: Record<string, true> = {
	"--system-prompt": true,
	"--append-system-prompt": true,
	"--add-dir": true,
	"--tools": true,
	"--profile": true,
	"--session-dir": true,
	"--config": true,
};

/** Drop denylisted flags (and their separate value tokens) from a flag list.
 * Handles both `--flag value` and `--flag=value` forms. Pair-aware: the value
 * of a non-denylisted valued flag is pushed verbatim and never inspected, so
 * a legitimate value that merely looks like a protected flag survives. */
export function stripDenylistedFlags(flags: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const token = flags[i];
		if (!token.startsWith("--")) {
			out.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (DENYLISTED[name] === true) {
			// `--flag value`: the value rides with the flag unless the next token is
			// itself flag-looking (then the flag is treated as valueless). The
			// `--flag=value` form carries its value in the dropped token already.
			if (eq === -1 && DENYLISTED_WITH_VALUE[name] === true) {
				const next = flags[i + 1];
				if (next !== undefined && !next.startsWith("-")) i++;
			}
			continue;
		}
		out.push(token);
		// Value position of a valued non-denylisted flag is opaque data.
		if (eq === -1 && VALUED_FLAGS[name] === true) {
			const next = flags[i + 1];
			if (next !== undefined) {
				out.push(next);
				i++;
			}
		}
	}
	return out;
}

/** Map a launch profile to agent CLI flags. Output order is fixed so the
 * effective command line preview is stable. The denylist is enforced at the
 * sidecar spawn site over the combined user flags (sidecar.ts #spawn), not
 * here: this mapping emits only constant flag names and profile values are
 * data, so a value that looks like a protected flag must survive intact. */
export function profileToFlags(profile: LaunchProfile): string[] {
	const flags: string[] = [];
	if (typeof profile.systemPrompt === "string" && profile.systemPrompt.trim() !== "") {
		flags.push("--system-prompt", profile.systemPrompt);
	}
	if (typeof profile.appendSystemPrompt === "string" && profile.appendSystemPrompt.trim() !== "") {
		flags.push("--append-system-prompt", profile.appendSystemPrompt);
	}
	if (profile.noRules === true) flags.push("--no-rules");
	if (Array.isArray(profile.addDirs)) {
		for (const dir of profile.addDirs) {
			const trimmed = dir.trim();
			if (trimmed !== "") flags.push("--add-dir", trimmed);
		}
	}
	if (Array.isArray(profile.tools)) {
		const tools = profile.tools.map(tool => tool.trim()).filter(tool => tool !== "");
		if (tools.length > 0) flags.push("--tools", tools.join(","));
	}
	if (profile.noLsp === true) flags.push("--no-lsp");
	if (profile.planYolo === true) flags.push("--plan-yolo");
	if (typeof profile.profile === "string" && profile.profile.trim() !== "") {
		flags.push("--profile", profile.profile.trim());
	}
	if (typeof profile.sessionDir === "string" && profile.sessionDir.trim() !== "") {
		flags.push("--session-dir", profile.sessionDir.trim());
	}
	if (typeof profile.config === "string" && profile.config.trim() !== "") {
		flags.push("--config", profile.config.trim());
	}
	return flags;
}

/**
 * Sanitize untrusted prefs JSON into a launch profile. Unknown keys — e.g. a
 * hand-edited prefs file smuggling `"--session"` — are dropped before they
 * can reach the mapping, and empty/blank values are normalized away so a
 * cleaned profile with no keys means "no profile".
 */
export function parseLaunchProfile(raw: unknown): LaunchProfile {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const profile: LaunchProfile = {};
	if (typeof record.systemPrompt === "string" && record.systemPrompt.trim() !== "") {
		profile.systemPrompt = record.systemPrompt;
	}
	if (typeof record.appendSystemPrompt === "string" && record.appendSystemPrompt.trim() !== "") {
		profile.appendSystemPrompt = record.appendSystemPrompt;
	}
	if (record.noRules === true) profile.noRules = true;
	if (Array.isArray(record.addDirs)) {
		const dirs = record.addDirs
			.filter((dir): dir is string => typeof dir === "string")
			.map(dir => dir.trim())
			.filter(dir => dir !== "");
		if (dirs.length > 0) profile.addDirs = dirs;
	}
	if (Array.isArray(record.tools)) {
		const tools = record.tools
			.filter((tool): tool is string => typeof tool === "string")
			.map(tool => tool.trim())
			.filter(tool => tool !== "");
		if (tools.length > 0) profile.tools = tools;
	}
	if (record.noLsp === true) profile.noLsp = true;
	if (record.planYolo === true) profile.planYolo = true;
	if (typeof record.profile === "string" && record.profile.trim() !== "") {
		profile.profile = record.profile.trim();
	}
	if (typeof record.sessionDir === "string" && record.sessionDir.trim() !== "") {
		profile.sessionDir = record.sessionDir.trim();
	}
	if (typeof record.config === "string" && record.config.trim() !== "") {
		profile.config = record.config.trim();
	}
	return profile;
}

/** Shell-safe charset: args outside it are single-quoted in the preview. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteShellArg(arg: string): string {
	if (arg.length > 0 && SHELL_SAFE.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render a flag list as a shell command line suffix (read-only preview). */
export function flagsToCommandLine(flags: readonly string[]): string {
	return flags.map(quoteShellArg).join(" ");
}
