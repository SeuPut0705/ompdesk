import { execFile } from "node:child_process";
import { type BuiltinReaState, reaEnabled, reaNodeSupported } from "../shared/builtin-mcp";
import { spawnPath } from "./shell-env";
import { executableName, findOnPath, needsShell, spawnCommand } from "./spawn";

type ReaRuntime = Omit<BuiltinReaState, "enabled">;

/** Use the same login-shell PATH as omp, including Finder-launched apps. */
async function probeReaRuntime(): Promise<ReaRuntime> {
	const path = await spawnPath();
	const platform = process.platform;
	const node = findOnPath([executableName("node", platform)], path, platform);
	if (!node) return { available: false, reason: "node-missing" };
	const version = (bin: string) => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(
			spawnCommand(bin),
			["--version"],
			{
				env: { ...process.env, PATH: path },
				shell: needsShell(bin),
				timeout: 10_000,
				windowsHide: true,
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
		);
		return promise;
	};
	let nodeVersion: string;
	try {
		nodeVersion = await version(node);
	} catch {
		return { available: false, reason: "node-failed" };
	}
	if (!reaNodeSupported(nodeVersion)) return { available: false, nodeVersion, reason: "node-version" };
	const npx = findOnPath(platform === "win32" ? ["npx.cmd", "npx.exe"] : ["npx"], path, platform);
	if (!npx) return { available: false, nodeVersion, reason: "npx-missing" };
	try {
		await version(npx);
	} catch {
		return { available: false, nodeVersion, reason: "npx-failed" };
	}
	return { available: true, nodeVersion };
}

let cached: Promise<ReaRuntime> | null = null;

/** Test seam: drop the cached probe so a stubbed PATH takes effect. */
export function resetReaRuntimeCache(): void {
	cached = null;
}

/**
 * Every tab spawn asks, so the node/npx probe runs once per process, like
 * systemOmp. An unavailable result is not cached: the next spawn or Settings
 * read probes again after the user installs Node.
 */
function reaRuntime(): Promise<ReaRuntime> {
	if (cached) return cached;
	const pending = probeReaRuntime();
	cached = pending;
	void pending.then(result => {
		if (!result.available && cached === pending) cached = null;
	});
	return pending;
}

export async function builtinReaState(pref: unknown): Promise<BuiltinReaState> {
	return { enabled: reaEnabled(pref), ...(await reaRuntime()) };
}
