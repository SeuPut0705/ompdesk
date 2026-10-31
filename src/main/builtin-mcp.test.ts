import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinReaState, resetReaRuntimeCache, spawnReaState } from "./builtin-mcp";
import { resetLoginShellEnvCache } from "./shell-env";
import { RM_TEMP } from "./test-fake-omp";

/**
 * Every tab spawn resolves the REA state before omp starts, so the node/npx
 * probe must not re-run per tab: a fresh tab that waits on two subprocesses
 * reaches `ready` hundreds of milliseconds after one that does not.
 */
const saved = new Map<string, string | undefined>();
let dir: string;
let calls: string;

function setEnv(key: string, value: string): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	process.env[key] = value;
}

/** Fake `node`/`npx` on PATH that log each run, so the test counts probes. */
async function installTools(nodeVersion: string): Promise<void> {
	for (const [name, output] of [
		["node", nodeVersion],
		["npx", "11.0.0"],
	]) {
		const file = path.join(dir, name);
		await fs.writeFile(file, `#!/bin/sh\necho ${name} >> '${calls}'\necho ${output}\n`);
		await fs.chmod(file, 0o755);
	}
	setEnv("PATH", dir);
	// A missing shell fails the login probe at once; the inherited PATH comes first anyway.
	setEnv("SHELL", path.join(dir, "no-such-shell"));
}

async function probes(): Promise<string[]> {
	return (await fs.readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-rea-probe-"));
	calls = path.join(dir, "calls.log");
	resetLoginShellEnvCache();
	resetReaRuntimeCache();
});

afterEach(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	resetLoginShellEnvCache();
	resetReaRuntimeCache();
	await fs.rm(dir, RM_TEMP);
});

describe.skipIf(process.platform === "win32")("builtinReaState", () => {
	it("probes node and npx once for every later spawn, keeping the preference live", async () => {
		await installTools("v26.0.0");
		await expect(builtinReaState(undefined)).resolves.toEqual({
			enabled: true,
			available: true,
			nodeVersion: "v26.0.0",
		});
		await expect(builtinReaState(false)).resolves.toEqual({
			enabled: false,
			available: true,
			nodeVersion: "v26.0.0",
		});
		expect(await probes()).toEqual(["node", "npx"]);
	});

	it("probes again after an unavailable result, so a Node install is picked up", async () => {
		await installTools("v20.0.0");
		await expect(builtinReaState(true)).resolves.toMatchObject({ available: false, reason: "node-version" });
		await installTools("v26.0.0");
		await expect(builtinReaState(true)).resolves.toMatchObject({ available: true, nodeVersion: "v26.0.0" });
		expect(await probes()).toEqual(["node", "node", "npx"]);
	});
});

describe.skipIf(process.platform === "win32")("spawnReaState", () => {
	const stored = async (file: string) => JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"));
	const identity = async (name: string) => {
		const bin = path.join(dir, name);
		const target = await fs.realpath(bin);
		const { size, mtimeMs } = await fs.stat(target);
		return JSON.stringify([bin, target, size, mtimeMs]);
	};
	/** A version manager's shim: the same script on PATH, the Node it runs picked by a config file beside it. */
	const installShim = async (nodeVersion: string) => {
		await installTools("unused");
		await fs.writeFile(path.join(dir, "node-version"), nodeVersion);
		// PATH holds only the fakes: shell builtins, no `cat`.
		await fs.writeFile(
			path.join(dir, "node"),
			`#!/bin/sh\necho node >> '${calls}'\nread v < '${dir}/node-version'\necho "$v"\n`,
		);
	};
	/** A Homebrew-style install: `node` on PATH is a symlink into the version's keg. */
	const installKeg = async (nodeVersion: string) => {
		const keg = path.join(dir, "Cellar", nodeVersion);
		await fs.mkdir(keg, { recursive: true });
		await fs.writeFile(path.join(keg, "node"), `#!/bin/sh\necho node >> '${calls}'\necho ${nodeVersion}\n`);
		await fs.chmod(path.join(keg, "node"), 0o755);
		await fs.rm(path.join(dir, "node"), { force: true });
		await fs.symlink(path.join(keg, "node"), path.join(dir, "node"));
	};

	it("serves a spawn the last launch's answer while this launch's probe replaces it", async () => {
		const file = path.join(dir, "rea-runtime.json");
		await installShim("v26.0.0");
		await expect(spawnReaState(undefined, file)).resolves.toEqual({
			enabled: true,
			available: true,
			nodeVersion: "v26.0.0",
		});
		await vi.waitFor(async () =>
			expect(await stored(file)).toEqual({
				node: await identity("node"),
				npx: await identity("npx"),
				nodeVersion: "v26.0.0",
			}),
		);
		// The next launch: the shim's config picks a newer Node, the shim itself is unchanged (the documented case a
		// stored answer cannot see): this spawn takes the stored answer, the probe behind it corrects later spawns.
		resetReaRuntimeCache();
		await fs.writeFile(path.join(dir, "node-version"), "v26.1.0");
		await expect(spawnReaState(false, file)).resolves.toEqual({
			enabled: false,
			available: true,
			nodeVersion: "v26.0.0",
		});
		await vi.waitFor(async () => expect((await stored(file))?.nodeVersion).toBe("v26.1.0"));
		await expect(spawnReaState(undefined, file)).resolves.toMatchObject({ nodeVersion: "v26.1.0" });
		expect(await probes()).toEqual(["node", "npx", "node", "npx"]);
	});

	it("never vouches for a Node upgraded behind the same PATH entry: a moved symlink or a binary replaced in place", async () => {
		const file = path.join(dir, "rea-runtime.json");
		await installTools("unused");
		await installKeg("v26.0.0");
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: true, nodeVersion: "v26.0.0" });
		await vi.waitFor(async () => expect((await stored(file))?.node).toBe(await identity("node")));

		// `brew switch`/nvm: the same `node` on PATH now resolves to an unsupported keg; the spawn waits for the probe.
		resetReaRuntimeCache();
		await installKeg("v20.0.0");
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		await vi.waitFor(async () => expect(await stored(file)).toBeNull());

		// Back on a supported keg, then that binary replaced in place (same path and target, new mtime).
		resetReaRuntimeCache();
		await installKeg("v26.0.0");
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: true, nodeVersion: "v26.0.0" });
		await vi.waitFor(async () => expect((await stored(file))?.node).toBe(await identity("node")));
		resetReaRuntimeCache();
		const binary = path.join(dir, "Cellar", "v26.0.0", "node");
		await fs.writeFile(binary, `#!/bin/sh\necho node >> '${calls}'\necho v20.0.0\n`);
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(binary, later, later);
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
	});

	it("waits for the probe when Node is elsewhere now, and an unavailable answer removes the stored one", async () => {
		const file = path.join(dir, "rea-runtime.json");
		await installTools("v20.0.0");
		await fs.writeFile(
			file,
			JSON.stringify({ node: "/gone/node", npx: await identity("npx"), nodeVersion: "v26.0.0" }),
		);
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		await vi.waitFor(async () => expect(await stored(file)).toBeNull());
	});

	it("serves an unavailable answer while Node is unchanged; a Node upgraded behind PATH is waited for", async () => {
		const file = path.join(dir, "rea-runtime.json");
		await installTools("unused");
		await installKeg("v20.0.0");
		// While a `gate` FIFO exists the old keg's `node` blocks on it, as a slow shim would.
		const gate = path.join(dir, "gate");
		await fs.writeFile(
			path.join(dir, "Cellar", "v20.0.0", "node"),
			`#!/bin/sh\necho node >> '${calls}'\nif [ -p '${gate}' ]; then read go < '${gate}'; fi\necho v20.0.0\n`,
		);
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		expect(await probes()).toEqual(["node"]);
		// The next tab takes that answer while the probe behind it (a fix is seen) is still running.
		execFileSync("/usr/bin/mkfifo", [gate]);
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		await vi.waitFor(async () => expect(await probes()).toEqual(["node", "node"]));
		await fs.writeFile(gate, "go\n");
		// Gone before anything else runs `node`: the released probe may already have settled, and the next one would
		// block on a FIFO nobody writes again.
		await fs.rm(gate);
		// That probe settles first: one already running when Node changes answers for the Node it found.
		await builtinReaState(true);
		// `brew upgrade node`: the same `node` on PATH is another keg, so the spawn waits for the probe.
		await installKeg("v26.0.0");
		await expect(spawnReaState(true, file)).resolves.toEqual({
			enabled: true,
			available: true,
			nodeVersion: "v26.0.0",
		});
		await vi.waitFor(async () => expect((await stored(file))?.nodeVersion).toBe("v26.0.0"));
	});

	it("an unavailable answer behind a shim is corrected by the probe behind the next spawn", async () => {
		const file = path.join(dir, "rea-runtime.json");
		await installShim("v20.0.0");
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		// `mise use node@26`: the shim is unchanged, so one spawn takes the old answer while its probe sees the fix.
		await fs.writeFile(path.join(dir, "node-version"), "v26.0.0");
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: false, reason: "node-version" });
		await vi.waitFor(async () => expect((await stored(file))?.nodeVersion).toBe("v26.0.0"));
		await expect(spawnReaState(true, file)).resolves.toMatchObject({ available: true, nodeVersion: "v26.0.0" });
		// Settings asks the probe itself, never the kept answer.
		await expect(builtinReaState(true)).resolves.toMatchObject({ available: true, nodeVersion: "v26.0.0" });
	});
});
