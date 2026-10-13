import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { type BuiltinReaState, reaEnabled, reaNodeSupported } from "../shared/builtin-mcp";
import { ompNeedsShell, ompSpawnCommand } from "./omp-runtime";
import { spawnPath } from "./shell-env";

type ReaRuntime = Omit<BuiltinReaState, "enabled">;

/** Use the same login-shell PATH as omp, including Finder-launched apps. */
async function probeReaRuntime(): Promise<ReaRuntime> {
	const path = await spawnPath();
	const windows = process.platform === "win32";
	const find = (names: string[]) => {
		for (const dir of path.split(delimiter).filter(Boolean)) {
			for (const name of names) {
				const file = join(dir, name);
				try {
					accessSync(file, windows ? constants.F_OK : constants.X_OK);
					return file;
				} catch {
					// Continue PATH lookup, as omp-runtime does.
				}
			}
		}
		return undefined;
	};
	const node = find(windows ? ["node.exe"] : ["node"]);
	if (!node) return { available: false, reason: "node-missing" };
	const version = (bin: string) => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(
			ompSpawnCommand(bin),
			["--version"],
			{
				env: { ...process.env, PATH: path },
				shell: ompNeedsShell(bin),
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
	const npx = find(windows ? ["npx.cmd", "npx.exe"] : ["npx"]);
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
