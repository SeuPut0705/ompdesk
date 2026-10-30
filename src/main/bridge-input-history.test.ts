import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { StockHelper } from "./stock-helper";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("stock history and compaction bridge", () => {
	it("shares history bidirectionally, skips secrets, and uses stock compaction helpers", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-bridge-"));
		const agent = path.join(profile, "agent");
		await fs.mkdir(agent, { mode: 0o700 });
		const realAgent = path.join(os.homedir(), ".omp/agent");
		await fs.copyFile(path.join(realAgent, "config.yml"), path.join(agent, "config.yml")).catch(() => {});
		if (existsSync(path.join(realAgent, "agent.db")))
			execFileSync("sqlite3", [
				path.join(realAgent, "agent.db"),
				`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`,
			]);
		const address = newBridgeAddress();
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: profile,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_BRIDGE: address,
		};
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
			{ cwd: profile, env, stdio: "pipe" },
		);
		const client = new GuiBridgeClient(address);
		let helper: StockHelper | undefined;
		let errors = "";
		child.stderr.on("data", chunk => {
			errors += String(chunk);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				// Real child readiness is event-driven; this deadline only diagnoses a stuck external omp.
				const timer = setTimeout(() => reject(new Error(`omp did not become ready: ${errors}`)), 40_000);
				child.once("error", error => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", code => {
					clearTimeout(timer);
					reject(new Error(`omp exited ${code}: ${errors}`));
				});
				let output = "";
				child.stdout.on("data", chunk => {
					output += String(chunk);
					if (/"type"\s*:\s*"ready"/.test(output)) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
			await client.connect();
			// Every area loads and every REQUIREMENTS entry resolves on the installed omp.
			expect(await client.request("capabilities")).toMatchObject({ unavailable: [] });
			// Idle compaction attaches to the live session; an empty fresh session never arms it.
			expect(await client.request("idle_compaction_draft", { empty: true })).toEqual({ armed: false });
			await expect(client.request("idle_compaction_draft", {})).rejects.toThrow("needs {empty: boolean}");
			// The idle recap attaches the same way and never arms on a fresh session.
			expect(await client.request("recap_draft", { empty: true })).toEqual({ armed: false });
			await expect(client.request("recap_draft", {})).rejects.toThrow("needs {empty: boolean}");
			// No goal yet: no OMPdesk time limit, and setting one is refused.
			expect(await client.request("modes.goal_time_limit")).toEqual({ timeLimitSeconds: null });
			await expect(client.request("modes.goal_set_time_limit", { minutes: 5 })).rejects.toThrow("No active goal");
			// Context inspector: per-tool counts add up to stock's own tool-schema total, entries open.
			const inspected = await client.request<{
				categories: Record<string, number>;
				entries: Array<{ id: string; category: string; tokens: number }>;
			}>("context.inspect", {});
			const report = await client.request<{ breakdown: { systemToolsTokens: number } }>("composer.context_report");
			const { builtinTools, mcpTools, extensionTools } = inspected.categories;
			expect(builtinTools + mcpTools + extensionTools).toBe(report.breakdown.systemToolsTokens);
			expect(inspected.entries.find(entry => entry.id === "tool:read")).toMatchObject({ category: "builtinTools" });
			expect(inspected.entries.find(entry => entry.id === "prompt:0")?.tokens).toBeGreaterThan(0);
			const readTool = await client.request<{ text: string; truncated: boolean }>("context.entry", {
				id: "tool:read",
			});
			expect(readTool.text).toContain('"type"');
			await expect(client.request("context.entry", { id: "msg:99:0" })).rejects.toThrow("no longer in the context");
			expect(await client.request("context.inspect", { entries: false })).toMatchObject({ entries: [] });
			expect(await client.request("history_record", { prompt: "from OMPdesk", cwd: profile })).toEqual({
				skipped: false,
			});
			// A separate Bun process uses the terminal's stock API, against the same isolated history.db.
			const script = path.join(profile, "history-check.ts");
			await fs.writeFile(
				script,
				`import { HistoryStorage } from ${JSON.stringify(path.join(stockRoot, "src/session/history-storage.ts"))};\nconst history = HistoryStorage.open();\nconsole.log(JSON.stringify(history.getRecent(20)));\nawait history.add("from terminal omp", ${JSON.stringify(profile)});\nHistoryStorage.close();\n`,
			);
			const terminal = JSON.parse(execFileSync("bun", [script], { env, encoding: "utf8" })) as Array<{
				prompt: string;
			}>;
			expect(terminal.some(entry => entry.prompt === "from OMPdesk")).toBe(true);
			// Reads are the stock helper's, on the same history.db the tab's omp writes: the handle it opened first still
			// sees a write another process makes after, with no change notice.
			helper = new StockHelper(path.resolve("resources/gui-bridge"), {
				spawnWorker: async () =>
					spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
						env: { ...env, OMP_PACKAGE_ROOT: stockRoot },
						stdio: ["pipe", "pipe", "pipe"],
					}),
			});
			const recent = await helper.request<Array<{ prompt: string }>>("history.recent", { limit: 20 });
			expect(recent.some(entry => entry.prompt === "from terminal omp")).toBe(true);
			expect(await client.request("history_record", { prompt: "written after the helper opened" })).toEqual({
				skipped: false,
			});
			expect(
				(await helper.request<Array<{ prompt: string }>>("history.recent", { limit: 1 })).map(
					entry => entry.prompt,
				),
			).toEqual(["written after the helper opened"]);
			for (const prompt of ["/login:secret", "/join secret-link", "/mcp add server --token secret"]) {
				expect(await client.request("history_record", { prompt })).toEqual({ skipped: true });
			}
			const safeHistory = await helper.request<Array<{ prompt: string }>>("history.recent", { limit: 20 });
			expect(safeHistory.some(entry => entry.prompt.includes("secret"))).toBe(false);
			expect(await helper.request("history.search", { query: "terminal omp", cwd: profile })).toMatchObject([
				{ prompt: "from terminal omp" },
			]);
			for (const [input, value] of [
				["90k", 90_000],
				["1m", 1_000_000],
				["80%", "80%"],
			]) {
				expect(await client.request("compaction_limits", { key: "openai/gpt", input })).toEqual({
					ok: true,
					value,
				});
			}
			expect(await client.request("compaction_limits", { key: "openai/gpt", input: "150%" })).toEqual({
				ok: false,
				limitError: "percent",
			});
			expect(await client.request("compaction_limits", { key: "open*/gpt", input: "90k" })).toEqual({
				ok: false,
				modelError: "star",
			});
			expect(
				await client.request("compaction_limits", {
					values: { "openai/gpt": 90_000, "anthropic/*": "80%", "clear/key": null },
				}),
			).toEqual({
				rows: [
					{ key: "anthropic/*", value: "80%", text: "80%" },
					{ key: "openai/gpt", value: 90_000, text: "90k" },
				],
			});
			await fs.writeFile(
				script,
				`import { parseSlashCommand as stock } from ${JSON.stringify(path.join(stockRoot, "src/slash-commands/helpers/parse.ts"))};\nimport { parseSlashCommand as gui } from ${JSON.stringify(path.resolve("src/renderer/lib/slash-command.ts"))};\nconst cases = ["/foo bar", "/foo:bar", "/Foo_Bar: baz:qux", "/한글", "/", " /foo", "/foo bar:baz", "/foo:bar baz"];\nconsole.log(JSON.stringify(cases.every(text => JSON.stringify(stock(text)) === JSON.stringify(gui(text)))));\n`,
			);
			expect(execFileSync("bun", [script], { env, encoding: "utf8" }).trim()).toBe("true");
			// Recent models are stock's own MRU order from the profile's agent.db.
			const mru = existsSync(path.join(agent, "agent.db"))
				? execFileSync(
						"sqlite3",
						[path.join(agent, "agent.db"), "SELECT model_key FROM model_usage ORDER BY last_used_at DESC"],
						{ encoding: "utf8" },
					)
						.split("\n")
						.filter(Boolean)
				: [];
			expect(await client.request("recent_models")).toEqual({ selectors: mru });
			// A fresh journal has compacted nothing yet.
			expect(await client.request("sessions.usage_history")).toMatchObject({ compactions: 0 });
		} finally {
			client.close();
			await helper?.stop();
			child.stdin.end();
			child.kill();
			await new Promise<void>(resolve => {
				if (child.exitCode !== null || child.signalCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
			removeBridgeAddress(address);
			await fs.rm(profile, { recursive: true, force: true });
		}
	}, 60_000);
});
