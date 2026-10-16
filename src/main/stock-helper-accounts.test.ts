/**
 * The stock helper's `accounts.providers` (resources/gui-bridge/stock-helper/accounts.ts): the providers with a
 * stored credential, read through stock's own `discoverAuthStorage`, ids only. A fake install checks the shaping
 * (deduplicated, no token or identity leaves the worker, the store is closed); the real omp, when this machine
 * has one, runs against a throwaway agent dir seeded with two API-key credentials.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** One request to a stock worker over its stdio protocol; the answer line, parsed. */
async function ask(root: string, env: Record<string, string> = {}): Promise<{ result?: unknown; error?: string }> {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	child.stdin.write(`${JSON.stringify({ id: 1, method: "accounts.providers" })}\n`);
	const { value } = await lines.next();
	return JSON.parse(value as string) as { result?: unknown; error?: string };
}

async function fakeInstall(sdk: string | null): Promise<{ root: string; closed: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-accounts-"));
	tempDirs.push(dir);
	const root = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module", exports: { "./sdk": "./sdk.ts" } }),
	);
	const closed = path.join(dir, "closed");
	if (sdk) await fs.writeFile(path.join(root, "sdk.ts"), sdk.replaceAll("__CLOSED__", JSON.stringify(closed)));
	return { root, closed };
}

describe("accounts.providers", () => {
	it("lists each connected provider once, without any credential field, and closes the store", async () => {
		const { root, closed } = await fakeInstall(`
import { writeFileSync } from "node:fs";
export async function discoverAuthStorage() {
	return {
		credentials: {
			reload: async () => {},
			list: () => [
				{ id: 1, provider: "anthropic", credential: { type: "oauth", access: "SECRET-ACCESS", refresh: "SECRET-REFRESH" } },
				{ id: 2, provider: "anthropic", credential: { type: "api_key", key: "SECRET-KEY" } },
				{ id: 3, provider: "github-copilot", email: "me@example.com" },
				{ id: 4 },
			],
		},
		close: () => writeFileSync(__CLOSED__, ""),
	};
}
`);
		const answer = await ask(root);
		expect(answer).toEqual({ id: 1, result: { providers: ["anthropic", "github-copilot"] } });
		expect(JSON.stringify(answer)).not.toContain("SECRET");
		expect(existsSync(closed)).toBe(true);
	});

	it("says so when the installed omp has no discoverAuthStorage", async () => {
		const { root } = await fakeInstall("export const other = 1;\n");
		expect((await ask(root)).error).toBe("Installed omp has no discoverAuthStorage");
	});

	it("says so when OMP_PACKAGE_ROOT is missing", async () => {
		const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, OMP_PACKAGE_ROOT: "" },
		});
		children.push(child);
		child.stderr.resume();
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		child.stdin.write(`${JSON.stringify({ id: 1, method: "accounts.providers" })}\n`);
		const { value } = await lines.next();
		expect(JSON.parse(value as string)).toEqual({ id: 1, error: "OMP_PACKAGE_ROOT is required" });
	});
});

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
describe.skipIf(!existsSync(path.join(realRoot, "package.json")))("the real stock omp", () => {
	it("reads the providers of a throwaway agent dir's agent.db, and never the user's", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-accounts-real-"));
		tempDirs.push(agentDir);
		const env = { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: "omp-config", OMP_PROFILE: "", PI_PROFILE: "" };
		const seed = spawnSync(
			"bun",
			[
				"-e",
				`import { discoverAuthStorage } from ${JSON.stringify(path.join(realRoot, "src", "sdk.ts"))};
const auth = await discoverAuthStorage();
await auth.credentials.set("anthropic", { type: "api_key", key: "sk-test-1" });
await auth.credentials.set("github-copilot", { type: "api_key", key: "sk-test-2" });
auth.close();`,
			],
			{ env: { ...process.env, ...env }, encoding: "utf8" },
		);
		expect(seed.status).toBe(0);
		const answer = await ask(realRoot, env);
		expect(answer.error).toBeUndefined();
		expect(answer.result).toEqual({ providers: expect.arrayContaining(["anthropic", "github-copilot"]) });
	}, 60_000);
});
