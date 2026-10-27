import { execFile } from "node:child_process";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { type BuiltinReaState, reaEnabled, reaNodeSupported } from "../shared/builtin-mcp";
import { writeFileAtomic } from "./atomic-file";
import { spawnPath } from "./shell-env";
import { executableName, findOnPath, needsShell, spawnCommand } from "./spawn";

type ReaRuntime = Omit<BuiltinReaState, "enabled">;

/** A probe's answer, with the executables an available answer ran (they key the stored answer). */
interface ReaProbe {
	runtime: ReaRuntime;
	tools?: ReaTools;
}

/** Each executable as `toolIdentity` names it. */
interface ReaTools {
	node: string;
	npx: string;
}

/** The last available answer, kept across launches (`spawnReaState`). */
interface StoredReaRuntime extends ReaTools {
	nodeVersion: string;
}

function findNode(path: string): string | null {
	return findOnPath([executableName("node", process.platform)], path, process.platform);
}

function findNpx(path: string): string | null {
	return findOnPath(process.platform === "win32" ? ["npx.cmd", "npx.exe"] : ["npx"], path, process.platform);
}

/**
 * The executable found on PATH, the file it resolves to and that file's size and mtime: a Homebrew or nvm upgrade
 * behind the same PATH entry (a symlink moved to a new keg, a binary replaced in place) is another identity, so a
 * stored answer never vouches for a Node it did not run. A version manager's shim (mise, asdf, volta) is a script
 * that stays put while its config picks another Node: that change is not seen here (the probe behind the spawn
 * replaces the answer for every later spawn). `null` when the file is gone.
 */
async function toolIdentity(bin: string | null): Promise<string | null> {
	if (!bin) return null;
	try {
		const target = await realpath(bin);
		const { size, mtimeMs } = await stat(target);
		return JSON.stringify([bin, target, size, mtimeMs]);
	} catch {
		return null;
	}
}

/** Use the same login-shell PATH as omp, including Finder-launched apps. */
async function probeReaRuntime(): Promise<ReaProbe> {
	const path = await spawnPath();
	const node = findNode(path);
	if (!node) return { runtime: { available: false, reason: "node-missing" } };
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
	// Each identity is read before its binary runs: one replaced while the probe ran keys an answer no spawn matches.
	const nodeId = await toolIdentity(node);
	let nodeVersion: string;
	try {
		nodeVersion = await version(node);
	} catch {
		return { runtime: { available: false, reason: "node-failed" } };
	}
	if (!reaNodeSupported(nodeVersion)) return { runtime: { available: false, nodeVersion, reason: "node-version" } };
	const npx = findNpx(path);
	if (!npx) return { runtime: { available: false, nodeVersion, reason: "npx-missing" } };
	const npxId = await toolIdentity(npx);
	try {
		await version(npx);
	} catch {
		return { runtime: { available: false, nodeVersion, reason: "npx-failed" } };
	}
	return {
		runtime: { available: true, nodeVersion },
		...(nodeId && npxId ? { tools: { node: nodeId, npx: npxId } } : {}),
	};
}

let cached: Promise<ReaProbe> | null = null;
let stored: { file: string; read: Promise<StoredReaRuntime | null> } | null = null;

/** Test seam: drop the cached probe so a stubbed PATH takes effect, and forget the stored answer read. */
export function resetReaRuntimeCache(): void {
	cached = null;
	stored = null;
}

/**
 * Every tab spawn asks, so the node/npx probe runs once per process, like
 * systemOmp. An unavailable result is not cached: the next spawn or Settings
 * read probes again after the user installs Node.
 */
function reaProbe(): Promise<ReaProbe> {
	if (cached) return cached;
	const pending = probeReaRuntime();
	cached = pending;
	void pending.then(result => {
		if (!result.runtime.available && cached === pending) cached = null;
	});
	return pending;
}

export async function builtinReaState(pref: unknown): Promise<BuiltinReaState> {
	return { enabled: reaEnabled(pref), ...(await reaProbe()).runtime };
}

async function readStored(file: string): Promise<StoredReaRuntime | null> {
	try {
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		if (typeof value !== "object" || value === null) return null;
		const { node, npx, nodeVersion } = value as Record<string, unknown>;
		return typeof node === "string" && typeof npx === "string" && typeof nodeVersion === "string"
			? { node, npx, nodeVersion }
			: null;
	} catch {
		return null;
	}
}

/** The probe's answer replaces the stored one: an available answer is written, any other removes it. */
async function store(file: string, previous: StoredReaRuntime | null, probe: ReaProbe): Promise<void> {
	const next =
		probe.runtime.available && probe.tools && probe.runtime.nodeVersion
			? { ...probe.tools, nodeVersion: probe.runtime.nodeVersion }
			: null;
	if (previous?.node === next?.node && previous?.npx === next?.npx && previous?.nodeVersion === next?.nodeVersion)
		return;
	if (stored?.file === file) stored.read = Promise.resolve(next);
	await (next ? writeFileAtomic(file, JSON.stringify(next)) : rm(file, { force: true })).catch(() => undefined);
}

/**
 * A tab's spawn: REA's runtime as the last launch's probe found it, when Node and npx are still the executables on
 * PATH it ran (`toolIdentity`: path, resolved file, size, mtime), while this launch's probe runs behind it (its
 * answer serves every later spawn and replaces the stored one). `node --version` and `npx --version` (through a
 * version manager's shims) took 0.3 to 1 s, all of it on a restored tab's way to its first spawn. No stored answer,
 * or other executables, waits for the probe as before.
 */
export async function spawnReaState(pref: unknown, file: string): Promise<BuiltinReaState> {
	const enabled = reaEnabled(pref);
	if (stored?.file !== file) stored = { file, read: readStored(file) };
	const read = stored.read;
	const probe = reaProbe();
	void Promise.all([read, probe]).then(([previous, result]) => store(file, previous, result));
	const last = await read;
	if (last) {
		const path = await spawnPath();
		const [nodeId, npxId] = await Promise.all([toolIdentity(findNode(path)), toolIdentity(findNpx(path))]);
		if (nodeId === last.node && npxId === last.npx && reaNodeSupported(last.nodeVersion))
			return { enabled, available: true, nodeVersion: last.nodeVersion };
	}
	return { enabled, ...(await probe).runtime };
}
