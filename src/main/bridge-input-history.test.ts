import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

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
			const recent = await client.request<Array<{ prompt: string }>>("history_recent", { limit: 20 });
			expect(recent.some(entry => entry.prompt === "from terminal omp")).toBe(true);
			for (const prompt of ["/login:secret", "/join secret-link", "/mcp add server --token secret"]) {
				expect(await client.request("history_record", { prompt })).toEqual({ skipped: true });
			}
			const safeHistory = await client.request<Array<{ prompt: string }>>("history_recent", { limit: 20 });
			expect(safeHistory.some(entry => entry.prompt.includes("secret"))).toBe(false);
			expect(await client.request("history_search", { query: "terminal omp", cwd: profile })).toMatchObject([
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
		} finally {
			client.close();
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
