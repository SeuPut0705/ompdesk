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
async function ask(
	root: string,
	env: Record<string, string> = {},
	method = "accounts.providers",
	base: Record<string, string | undefined> = process.env,
): Promise<{ result?: unknown; error?: string }> {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...base, ...env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	child.stdin.write(`${JSON.stringify({ id: 1, method })}\n`);
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
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			type: "module",
			exports: { "./sdk": "./sdk.ts", "./mcp/oauth-flow": "./oauth-flow.ts" },
		}),
	);
	// Stock's predicate for an MCP server's sign-in in the shared credential store.
	await fs.writeFile(
		path.join(root, "oauth-flow.ts"),
		'export const isManagedMCPOAuthCredentialId = id => typeof id === "string" && id.startsWith("mcp_oauth:");\n',
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
				{ id: 5, provider: "mcp_oauth:profile:default:https://mcp.example/mcp", credential: { access: "SECRET-MCP" } },
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
const { mcpOAuthCredentialId } = await import(${JSON.stringify(path.join(realRoot, "src", "mcp", "oauth-flow.ts"))});
await auth.credentials.set(mcpOAuthCredentialId("https://mcp.example.test/mcp"), { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000 });
auth.close();`,
			],
			{ env: { ...process.env, ...env }, encoding: "utf8" },
		);
		expect(seed.status).toBe(0);
		const answer = await ask(realRoot, env);
		expect(answer.error).toBeUndefined();
		// An MCP server's sign-in shares the store but is no model provider.
		expect((answer.result as { providers: string[] }).providers.sort()).toEqual(["anthropic", "github-copilot"]);
	}, 60_000);

	it("counts an agent dir holding only an MCP sign-in as not signed in to any model", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-accounts-mcp-"));
		tempDirs.push(agentDir);
		// No model key from the developer's environment: only PATH and a private HOME.
		const base = { PATH: process.env.PATH, HOME: agentDir, USERPROFILE: agentDir };
		const env = { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: "omp-config", OMP_PROFILE: "", PI_PROFILE: "" };
		const seed = spawnSync(
			"bun",
			[
				"-e",
				`import { discoverAuthStorage } from ${JSON.stringify(path.join(realRoot, "src", "sdk.ts"))};
import { mcpOAuthCredentialId } from ${JSON.stringify(path.join(realRoot, "src", "mcp", "oauth-flow.ts"))};
const auth = await discoverAuthStorage();
await auth.credentials.set(mcpOAuthCredentialId("https://mcp.example.test/mcp"), { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000 });
auth.close();`,
			],
			{ env: { ...base, ...env }, encoding: "utf8" },
		);
		expect(seed.status, seed.stderr).toBe(0);
		const answer = await ask(realRoot, env, "accounts.signedIn", base);
		expect(answer.error).toBeUndefined();
		expect(answer.result).toEqual({ signedIn: false });
	}, 60_000);
});
