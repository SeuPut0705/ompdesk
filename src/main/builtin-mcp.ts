import { execFile } from "node:child_process";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { type BuiltinReaState, reaEnabled, reaNodeSupported } from "../shared/builtin-mcp";
import { writeFileAtomic } from "./atomic-file";
import { spawnPath } from "./shell-env";
import { executableName, findOnPath, needsShell, spawnCommand } from "./spawn";

type ReaRuntime = Omit<BuiltinReaState, "enabled">;

/** Node and npx on PATH as `toolIdentity` names each (null: none there, or gone): what a probe ran, its answer's key. */
interface ReaInstall {
	node: string | null;
	npx: string | null;
}

/** A probe's answer, with the executables it ran (they key the stored answer and the last unavailable one). */
interface ReaProbe {
	runtime: ReaRuntime;
	install: ReaInstall;
}

/** The last available answer, kept across launches (`spawnReaState`). */
interface StoredReaRuntime {
	node: string;
	npx: string;
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
	const npx = findNpx(path);
	// Both identities are read before either binary runs: one replaced while the probe ran keys an answer no spawn matches.
	const [nodeId, npxId] = await Promise.all([toolIdentity(node), toolIdentity(npx)]);
	const install = { node: nodeId, npx: npxId };
	if (!node) return { runtime: { available: false, reason: "node-missing" }, install };
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
		return { runtime: { available: false, reason: "node-failed" }, install };
	}
	if (!reaNodeSupported(nodeVersion)) {
		return { runtime: { available: false, nodeVersion, reason: "node-version" }, install };
	}
	if (!npx) return { runtime: { available: false, nodeVersion, reason: "npx-missing" }, install };
	try {
		await version(npx);
	} catch {
		return { runtime: { available: false, nodeVersion, reason: "npx-failed" }, install };
	}
	return { runtime: { available: true, nodeVersion }, install };
}

let cached: Promise<ReaProbe> | null = null;
/** The last unavailable answer (`spawnReaState`); null once a probe found REA available. */
let unavailable: ReaProbe | null = null;
let stored: { file: string; read: Promise<StoredReaRuntime | null> } | null = null;

/** Test seam: drop the cached probe so a stubbed PATH takes effect, and forget the stored and unavailable answers. */
export function resetReaRuntimeCache(): void {
	cached = null;
	unavailable = null;
	stored = null;
}

/**
 * Every tab spawn asks, so the node/npx probe runs once per process, like
 * systemOmp. An unavailable result is not cached: the next spawn or Settings
 * read probes again after the user installs Node. It is kept as `unavailable`
 * for a spawn to take while the executables it ran are unchanged.
 */
function reaProbe(): Promise<ReaProbe> {
	if (cached) return cached;
	const pending = probeReaRuntime();
	cached = pending;
	void pending.then(result => {
		if (cached !== pending) return;
		if (result.runtime.available) {
			unavailable = null;
			return;
		}
		cached = null;
		unavailable = result;
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
	const { node, npx } = probe.install;
	const { available, nodeVersion } = probe.runtime;
	const next = available && node && npx && nodeVersion ? { node, npx, nodeVersion } : null;
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
 *
 * An unavailable answer (Node missing, too old, failing) is not stored across launches, and the probe runs again
 * behind every spawn so a fix is seen; a spawn takes this process's last unavailable answer while Node and npx are
 * the executables it ran, rather than waiting for `node --version` again (every tab of a machine whose Node is below
 * REA's range paid it). A Node installed or upgraded behind PATH is another identity, so that spawn waits for the
 * probe; a shim whose config picks another Node is the one change not seen, by the next spawn only.
 */
export async function spawnReaState(pref: unknown, file: string): Promise<BuiltinReaState> {
	const enabled = reaEnabled(pref);
	if (stored?.file !== file) stored = { file, read: readStored(file) };
	const read = stored.read;
	const probe = reaProbe();
	void Promise.all([read, probe]).then(([previous, result]) => store(file, previous, result));
	const last = await read;
	const known = unavailable;
	if (last || known) {
		const path = await spawnPath();
		const [node, npx] = await Promise.all([toolIdentity(findNode(path)), toolIdentity(findNpx(path))]);
		if (last && node === last.node && npx === last.npx && reaNodeSupported(last.nodeVersion))
			return { enabled, available: true, nodeVersion: last.nodeVersion };
		if (known && node === known.install.node && npx === known.install.npx) return { enabled, ...known.runtime };
	}
	return { enabled, ...(await probe).runtime };
}
