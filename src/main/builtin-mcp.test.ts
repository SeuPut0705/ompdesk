import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinReaState, resetReaRuntimeCache } from "./builtin-mcp";
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
