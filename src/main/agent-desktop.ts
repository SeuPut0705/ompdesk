/**
 * What a session's omp is started with for the Computer use setting (pref `computerUse`, src/shared/computer-use.ts;
 * bridge half: resources/gui-bridge/modes/computer-use.ts), and which agent-desktop runs. Read at every spawn, so a
 * pick, or a newer copy the CLI updater installed, applies from a session's next start: the MCP root is mounted when
 * omp starts and cannot be switched live.
 *
 * Two copies can exist: the one the app ships (`<resources>/agent-desktop-bin`, the release pinned in
 * scripts/agent-desktop-pin.json, unpacked by `bun run build:agent-desktop`) and the one machine setup's updates keep
 * in the managed tools dir (src/main/setup/paths.ts `managedAgentDesktop`). The managed copy runs when its version is
 * at least the bundled one's, so an update is picked up and a stale managed copy never shadows a newer app.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DESKTOP_ENV, COMPUTER_USE_ENV } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { parseComputerUseEngine } from "../shared/computer-use";
import type { SetupPlatform } from "../shared/setup";
import { isNewer } from "../shared/version";
import { parseOmpVersion } from "./omp-runtime";
import { AGENT_DESKTOP_MIN_VERSION } from "./setup/archives";
import { managedAgentDesktop } from "./setup/paths";

/** The record `bun run build:agent-desktop` writes beside the bundled binaries (scripts/build-agent-desktop.ts). */
export const AGENT_DESKTOP_BUILD_RECORD = "agent-desktop.build.json";

/** An agent-desktop OMPdesk can run, and where it came from. */
export interface AgentDesktopCopy {
	source: "managed" | "bundled";
	path: string;
	version: string;
}

/**
 * The copy shipped in the app, from its build record. Null when the folder, its record or the executable is missing:
 * a dev run that never ran `bun run build:agent-desktop`, or a damaged install.
 */
export function bundledAgentDesktop(bundleDir: string, platform: SetupPlatform): AgentDesktopCopy | null {
	if (platform === "other") return null;
	const path = join(bundleDir, platform === "win32" ? "agent-desktop.exe" : "agent-desktop");
	let version: unknown;
	try {
		const record: unknown = JSON.parse(readFileSync(join(bundleDir, AGENT_DESKTOP_BUILD_RECORD), "utf8"));
		version = typeof record === "object" && record !== null && "version" in record ? record.version : undefined;
	} catch {
		return null;
	}
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !existsSync(path)) return null;
	return { source: "bundled", path, version };
}

/**
 * Which copy runs: the managed one when it answers a version of at least `AGENT_DESKTOP_MIN_VERSION` and the bundled
 * one's, else the bundled one; null when neither can.
 */
export function pickAgentDesktop(
	managed: { path: string; version: string } | null,
	bundled: AgentDesktopCopy | null,
): AgentDesktopCopy | null {
	if (
		managed &&
		!isNewer(AGENT_DESKTOP_MIN_VERSION, managed.version) &&
		(!bundled || !isNewer(bundled.version, managed.version))
	) {
		return { source: "managed", ...managed };
	}
	return bundled;
}

/** `--version` of each executable, kept while the file is the same (size, mtime, inode): one run per installed copy. */
const versions = new Map<string, { identity: string; version: string }>();

/** The version `exe --version` prints; null when it does not exist, fails or prints none. */
export async function agentDesktopVersion(exe: string): Promise<string | null> {
	const info = await stat(exe).catch(() => null);
	if (!info) return null;
	const identity = `${info.size}:${info.mtimeMs}:${info.ino}`;
	const known = versions.get(exe);
	if (known?.identity === identity) return known.version;
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(exe, ["--version"], { timeout: 15_000, windowsHide: true }, (error, stdout) =>
		resolve(error ? null : parseOmpVersion(stdout)),
	);
	const version = await promise;
	// A failure is not kept: a scan holding the file or a slow first start can pass by the next spawn.
	if (version) versions.set(exe, { identity, version });
	return version;
}

export interface AgentDesktopSources {
	toolsDir: string;
	/** `<resources>/agent-desktop-bin` (packaged), `resources/agent-desktop-bin/<platform>-<arch>` (dev). */
	bundleDir: string;
	platform: SetupPlatform;
	/** Test seam for the managed copy's `--version`. */
	version?: (exe: string) => Promise<string | null>;
}

/** The copy a session started now runs (`pickAgentDesktop` over the managed and the bundled copy). */
export async function agentDesktopToRun(sources: AgentDesktopSources): Promise<AgentDesktopCopy | null> {
	const { toolsDir, bundleDir, platform, version = agentDesktopVersion } = sources;
	if (platform === "other") return null;
	const exe = managedAgentDesktop(toolsDir, platform);
	const managedVersion = await version(exe);
	return pickAgentDesktop(
		managedVersion ? { path: exe, version: managedVersion } : null,
		bundledAgentDesktop(bundleDir, platform),
	);
}

export interface ComputerUseSpawn {
	/** `-e <root>` of the agent-desktop MCP server, only when it will run. */
	args: string[];
	/** `COMPUTER_USE_ENV` always (the bridge reads it), `AGENT_DESKTOP_ENV` beside the root. */
	env: Record<string, string>;
}

export interface ComputerUseSpawnInput extends AgentDesktopSources {
	/** The stored pref, as read. */
	pref: unknown;
	/** `resources/omp-builtin`: the root is its `agent-desktop/` folder. */
	builtinDir: string;
}

/**
 * - `builtin`: stock's eval `computer` prelude; nothing is mounted.
 * - `agent-desktop` with a copy to run (`agentDesktopToRun`): the root and that executable's path.
 * - `agent-desktop` without one (no bundled copy, a dev run, and no managed one): nothing is mounted and the bridge
 *   keeps the built-in prelude on and says so in the session (`missing`).
 */
export async function computerUseSpawn(input: ComputerUseSpawnInput): Promise<ComputerUseSpawn> {
	if (parseComputerUseEngine(input.pref) === "builtin") return { args: [], env: { [COMPUTER_USE_ENV]: "builtin" } };
	const copy = await agentDesktopToRun(input);
	if (!copy) return { args: [], env: { [COMPUTER_USE_ENV]: "missing" } };
	return {
		args: ["-e", join(input.builtinDir, "agent-desktop")],
		env: { [COMPUTER_USE_ENV]: "agent-desktop", [AGENT_DESKTOP_ENV]: copy.path },
	};
}
