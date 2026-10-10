import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseDocument } from "yaml";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "../../bridge-client";
import { RpcClient } from "../../rpc-client";
import type { LocalCommandContext } from "../types";
import { handlers as workspace } from "../workspace";
import { gitSync, initRepo, pathExists } from "./test-repos";
import { createWorktree, removeWorktree, stockWorktreeLocation } from "./worktree";

const omp = path.join(os.homedir(), ".bun", "bin", "omp");

describe.skipIf(!existsSync(omp) || process.platform === "win32")("installed stock worktree bridge", () => {
	it("uses stock paths, recognises old and stock checkouts, moves stock sessions, and writes PR push metadata", async () => {
		const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-stock-git-")));
		onTestFinished(() => fs.rm(scratch, { recursive: true, force: true }));
		const agent = path.join(scratch, "agent");
		const root = path.join(scratch, "wt");
		const repo = path.join(scratch, "repo");
		const origin = path.join(scratch, "origin");
		const bin = path.join(scratch, "bin");
		const address = newBridgeAddress();
		await fs.mkdir(agent, { mode: 0o700 });
		await fs.mkdir(bin);
		const realAgent = path.join(os.homedir(), ".omp", "agent");
		const config = path.join(realAgent, "config.yml");
		if (existsSync(config)) await fs.copyFile(config, path.join(agent, "config.yml"));
		const isolatedConfig = path.join(agent, "config.yml");
		const settings = parseDocument(existsSync(isolatedConfig) ? await fs.readFile(isolatedConfig, "utf8") : "{}");
		settings.setIn(["worktree", "base"], root);
		settings.setIn(["worktree", "clone"], false);
		await fs.writeFile(isolatedConfig, settings.toString());
		const db = path.join(realAgent, "agent.db");
		if (existsSync(db))
			execFileSync("sqlite3", [db, `VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`]);
		await initRepo(origin);
		gitSync(origin, "checkout", "-q", "-b", "feature");
		await fs.writeFile(path.join(origin, "feature.txt"), "PR head\n");
		gitSync(origin, "add", ".");
		gitSync(origin, "commit", "-q", "-m", "PR head");
		const oid = gitSync(origin, "rev-parse", "HEAD");
		gitSync(scratch, "clone", "-q", origin, repo);
		gitSync(repo, "checkout", "-q", "main");
		const payload = path.join(scratch, "pr.json");
		await fs.writeFile(
			payload,
			JSON.stringify({
				number: 42,
				title: "Local PR",
				url: "https://github.com/test/repo/pull/42",
				baseRefName: "main",
				headRefName: "feature",
				headRefOid: oid,
				isCrossRepository: false,
				maintainerCanModify: true,
			}),
		);
		await fs.writeFile(
			path.join(bin, "gh"),
			`#!/usr/bin/env bun\nimport { readFileSync } from 'node:fs';\nif (process.argv[2] === 'pr' && process.argv[3] === 'view') console.log(readFileSync(process.env.OMP_TEST_PR, 'utf8')); else { console.error('Unexpected gh invocation'); process.exit(1); }\n`,
			{ mode: 0o700 },
		);
		const child = spawn(
			omp,
			[
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				path.resolve("resources/gui-bridge/index.ts"),
			],
			{
				cwd: repo,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agent,
					PI_CONFIG_DIR: path.relative(os.homedir(), scratch),
					OMP_GUI_BRIDGE: address,
					OMP_WORKTREE_DIR: "",
					OMP_TEST_PR: payload,
					PATH: `${bin}:${path.join(os.homedir(), ".bun", "bin")}:${process.env.PATH}`,
					OMP_PROFILE: "",
					PI_PROFILE: "",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const bridge = new GuiBridgeClient(address);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk.toString();
		});
		const rpc = new RpcClient(frame => child.stdin.write(`${JSON.stringify(frame)}\n`), { timeout: 30_000 });
		const lines = createInterface({ input: child.stdout });
		lines.on("line", line => {
			try {
				const frame = JSON.parse(line) as RpcResponse;
				if (frame.type === "response") rpc.onResponse(frame);
			} catch {
				/* Stock may print startup diagnostics. */
			}
		});
		try {
			await expect.poll(() => existsSync(address) || child.exitCode !== null, { timeout: 60_000 }).toBe(true);
			expect(child.exitCode, stderr).toBeNull();
			await bridge.connect();
			const ready = await rpc.stock({ type: "get_state" });
			expect(ready.success, stderr).toBe(true);
			const ctx: LocalCommandContext = {
				cwd: repo,
				bridge,
				emit() {},
				omp: {
					bin: omp,
					version: "18.8.7",
					async run() {
						throw new Error("This test must use the live bridge");
					},
				},
				async send<T>(command: { type: string; [key: string]: unknown }) {
					const response = await rpc.stock(command as RpcCommand);
					if (!response.success) throw new Error(response.error);
					return response.data as T;
				},
			};
			const location = await stockWorktreeLocation(bridge, repo);
			expect(location.root).toBe(root);
			const created = await createWorktree(repo, { name: "gui" }, bridge);
			expect(created.path).toBe(path.join(root, `gui-gui-${location.hash}`));
			await removeWorktree({ path: created.path }, bridge, repo);
			expect(await pathExists(created.path)).toBe(false);
			const stock = await bridge.request<{ path: string }>("worktree_lifecycle_create");
			await removeWorktree({ path: stock.path }, bridge, repo);
			const legacy = path.join(root, "gui-legacy-7654321");
			gitSync(repo, "worktree", "add", "-q", "-b", "omp/gui/legacy", legacy);
			await removeWorktree({ path: legacy }, bridge, repo);
			expect(await pathExists(legacy)).toBe(false);
			const checkout = await bridge.request<{ path: string; branch: string }>("git.pr_checkout", {
				number: 42,
				repo: "test/repo",
			});
			expect(checkout.branch).toBe("pr-42");
			expect(gitSync(checkout.path, "rev-parse", "HEAD")).toBe(oid);
			for (const [key, value] of Object.entries({
				ompPrHeadRef: "feature",
				ompPrUrl: "https://github.com/test/repo/pull/42",
				ompPrIsCrossRepository: "false",
			})) {
				expect(gitSync(repo, "config", `branch.pr-42.${key}`)).toBe(value);
			}
			await removeWorktree({ path: checkout.path }, bridge, repo);
			gitSync(repo, "branch", "-f", "pr-42", "main");
			await expect(bridge.request("git.pr_checkout", { number: 42, repo: "test/repo" })).rejects.toThrow(
				"force=true",
			);
			const relative = path.join(repo, "relative");
			await fs.mkdir(relative);
			const moved = (await workspace.move_session({ type: "move_session", path: "relative" }, ctx)) as {
				cwd: string;
			};
			expect(await fs.realpath(moved.cwd)).toBe(relative);
			const movedUrl = (await workspace.move_session(
				{ type: "move_session", path: pathToFileURL(repo).href },
				ctx,
			)) as { cwd: string };
			expect(await fs.realpath(movedUrl.cwd)).toBe(repo);
			const movedHome = (await workspace.move_session({ type: "move_session", path: "~" }, ctx)) as { cwd: string };
			expect(await fs.realpath(movedHome.cwd)).toBe(await fs.realpath(os.homedir()));
		} finally {
			bridge.close();
			rpc.rejectAll("test teardown");
			lines.close();
			child.stdin.end();
			child.kill("SIGTERM");
			if (child.exitCode === null && child.signalCode === null)
				await new Promise<void>(resolve => child.once("exit", () => resolve()));
			removeBridgeAddress(address);
		}
	}, 120_000);
});
