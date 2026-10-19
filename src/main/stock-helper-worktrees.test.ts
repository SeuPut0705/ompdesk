/**
 * The stock helper's `git.worktree_location` (resources/gui-bridge/stock-helper/worktrees.ts): stock's worktree
 * directory and repo hash for a repository no session of this computer has open (`host.git.worktreeCreate`). On
 * the real omp, when this machine has one, it must answer what a live session's bridge answers
 * (worktree-lifecycle.ts `git.worktree_location`: pi-utils `getWorktreesDir`, `hashPath`), with `worktree.base`
 * read from the user's config and `OMP_WORKTREE_DIR` over it, as stock orders them.
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

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");

async function location(
	primaryRoot: string,
	env: Record<string, string>,
): Promise<{ result?: unknown; error?: string }> {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OMP_WORKTREE_DIR: "", ...env, OMP_PACKAGE_ROOT: realRoot },
	});
	children.push(child);
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	child.stdin.write(`${JSON.stringify({ id: 1, method: "git.worktree_location", params: { primaryRoot } })}\n`);
	const { value } = await lines.next();
	return JSON.parse(value as string) as { result?: unknown; error?: string };
}

describe.skipIf(!existsSync(path.join(realRoot, "package.json")))("the real stock omp", () => {
	it("answers stock's worktree base and repo hash, from the user's config and OMP_WORKTREE_DIR over it", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-wt-location-")));
		tempDirs.push(dir);
		const agentDir = path.join(dir, "agent");
		const repo = path.join(dir, "repo");
		const base = path.join(dir, "worktrees");
		await Promise.all([fs.mkdir(agentDir), fs.mkdir(repo)]);
		await fs.writeFile(path.join(agentDir, "config.yml"), `worktree:\n  base: ${base}\n`);
		const env = { PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: "omp-config", OMP_PROFILE: "", PI_PROFILE: "" };
		const hashed = spawnSync(
			"bun",
			["-e", `import { hashPath } from "@oh-my-pi/pi-utils"; console.log(hashPath(${JSON.stringify(repo)}));`],
			{ cwd: realRoot, encoding: "utf8" },
		);
		expect(hashed.status).toBe(0);
		const hash = hashed.stdout.trim();
		expect(hash).toMatch(/^[0-9a-f]{7}$/);

		expect(await location(repo, env)).toEqual({ id: 1, result: { root: base, hash } });
		const override = path.join(dir, "env-wt");
		expect(await location(repo, { ...env, OMP_WORKTREE_DIR: override })).toEqual({
			id: 1,
			result: { root: override, hash },
		});
		expect((await location("relative", env)).error).toMatch(/absolute/);
	}, 60_000);
});
