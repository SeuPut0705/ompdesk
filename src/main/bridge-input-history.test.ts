import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { StockHelper } from "./stock-helper";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("stock history and compaction bridge", () => {
	it("shares history bidirectionally, skips secrets, and uses stock compaction helpers", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-bridge-"));
		const agent = path.join(profile, "agent");
		await fs.mkdir(agent, { mode: 0o700 });
		// A model that is never called: rpc mode refuses to start without a default model, and a CI runner has none.
		await fs.writeFile(
			path.join(agent, "models.yml"),
			"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
		);
		// One context file and one skill, so the inspector's instruction-file and skill rows have stock's sources to show.
		await fs.writeFile(path.join(profile, "AGENTS.md"), "# Probe rules\nInspector probe rule text.\n");
		await fs.mkdir(path.join(agent, "skills", "inspector-probe"), { recursive: true });
		await fs.writeFile(
			path.join(agent, "skills", "inspector-probe", "SKILL.md"),
			"---\nname: inspector-probe\ndescription: Probe skill the context inspector lists.\n---\nBody.\n",
		);
		// The developer's agent.db, when there is one, so the recent-models check below reads a non-empty MRU.
		// node:sqlite, not the sqlite3 CLI, which Windows does not ship.
		const realAgentDb = path.join(os.homedir(), ".omp/agent/agent.db");
		if (existsSync(realAgentDb)) {
			const db = new DatabaseSync(realAgentDb, { readOnly: true });
			try {
				db.exec(`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`);
			} finally {
				db.close();
			}
		}
		const address = newBridgeAddress();
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: configDirName(profile),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_BRIDGE: address,
		};
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--skills",
				"inspector-probe",
				"--no-rules",
				"--model",
				"fixture/idle",
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
				entries: Array<{ id: string; category: string; label: string; tokens: number }>;
			}>("context.inspect", {});
			const report = await client.request<{
				breakdown: {
					systemToolsTokens: number;
					systemPromptTokens: number;
					instructionFilesTokens: number;
					skillsTokens: number;
				};
			}>("composer.context_report");
			const { builtinTools, mcpTools, extensionTools } = inspected.categories;
			expect(builtinTools + mcpTools + extensionTools).toBe(report.breakdown.systemToolsTokens);
			expect(inspected.entries.find(entry => entry.id === "tool:read")).toMatchObject({ category: "builtinTools" });
			// Stock's prompt sources: the context file and the skill are rows of their own that add up to stock's
			// totals, and the system prompt block no longer counts the skill list.
			const rows = (category: string) => inspected.entries.filter(entry => entry.category === category);
			const sum = (category: string) => rows(category).reduce((total, entry) => total + entry.tokens, 0);
			expect(inspected.categories.memoryFiles).toBe(report.breakdown.instructionFilesTokens);
			expect(inspected.categories.skills).toBe(report.breakdown.skillsTokens);
			expect(sum("memoryFiles")).toBe(inspected.categories.memoryFiles);
			expect(sum("skills")).toBe(inspected.categories.skills);
			const rulesRow = rows("memoryFiles").find(entry => entry.label.endsWith("AGENTS.md"));
			const skillRow = rows("skills").find(entry => entry.label === "inspector-probe");
			expect(rulesRow?.tokens).toBeGreaterThan(0);
			expect(skillRow?.tokens).toBeGreaterThan(0);
			const promptRow = inspected.entries.find(entry => entry.id === "prompt:0");
			expect(promptRow?.tokens).toBe(report.breakdown.systemPromptTokens);
			expect(promptRow?.tokens).toBeGreaterThan(0);
			const rulesText = await client.request<{ text: string }>("context.entry", { id: rulesRow?.id });
			expect(rulesText.text).toContain("Inspector probe rule text.");
			const skillText = await client.request<{ text: string }>("context.entry", { id: skillRow?.id });
			expect(skillText.text).toContain("inspector-probe: Probe skill the context inspector lists.");
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
				launch: async () => ({
					bin: "bun",
					args: [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"],
					env: { ...env, OMP_PACKAGE_ROOT: stockRoot },
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
			const mru: string[] = [];
			if (existsSync(path.join(agent, "agent.db"))) {
				const db = new DatabaseSync(path.join(agent, "agent.db"), { readOnly: true });
				try {
					for (const row of db.prepare("SELECT model_key FROM model_usage ORDER BY last_used_at DESC").all())
						mru.push(String(row.model_key));
				} finally {
					db.close();
				}
			}
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
			await removeWhenFree(profile);
		}
	}, 60_000);
});
