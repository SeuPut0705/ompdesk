import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { AgentMessage } from "../src/shared/rpc-types";
import { exitApp } from "./harness";

// Opt-in: snapshots read the source profile but the app only receives private
// copies. This audit never prompts a model and records no transcript content.
test("isolated real-session switch timing, transcript bytes and renderer heap", async () => {
	const source = process.env.OMP_GUI_TRANSCRIPT_SOURCE;
	const baseline = process.env.OMP_GUI_BASELINE_APP;
	test.skip(!source || !baseline, "Explicit isolated real-session benchmark");
	if (!source || !baseline) return;
	test.setTimeout(600_000);
	const journal = (await fs.readFile(source, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type: string; cwd?: string; message?: AgentMessage });
	const header = journal.find(entry => entry.type === "session");
	const target = journal.findLast(
		entry =>
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some(block => block.type === "text" && block.text.trim()),
	);
	if (!header?.cwd || target?.message?.timestamp === undefined)
		throw new Error("Session has no measurable terminal assistant row");
	const targetKey = `message-assistant-${target.message.timestamp}`;
	const results: object[] = [];
	for (let run = 0; run < 3; run++) {
		const subjects = [
			{ name: "before", executablePath: baseline },
			{ name: "after", executablePath: undefined },
		];
		for (const subject of run % 2 ? subjects.reverse() : subjects) {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-real-transcript-"));
			await fs.chmod(profile, 0o700);
			const agent = path.join(profile, "agent");
			const desktop = path.join(profile, "desktop");
			await Promise.all([fs.mkdir(agent, { mode: 0o700 }), fs.mkdir(desktop, { mode: 0o700 })]);
			const sourceAgent = path.join(os.homedir(), ".omp", "agent");
			await fs.copyFile(path.join(sourceAgent, "config.yml"), path.join(agent, "config.yml"));
			execFileSync("sqlite3", [
				"-readonly",
				path.join(sourceAgent, "agent.db"),
				`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`,
			]);
			const copied = path.join(agent, "sessions", "transcript-benchmark", path.basename(source));
			await fs.mkdir(path.dirname(copied), { recursive: true, mode: 0o700 });
			await fs.copyFile(source, copied);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language: "en", firstRunComplete: true, transcriptDetail: "full" }),
			);
			const env = {
				...process.env,
				PI_CODING_AGENT_DIR: agent,
				PI_CONFIG_DIR: path.relative(os.homedir(), profile),
				OMP_PROFILE: "",
				PI_PROFILE: "",
			};
			Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
			const app = await electron.launch({
				executablePath: subject.executablePath,
				args: [
					...(subject.name === "after"
						? [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js")]
						: []),
					header.cwd,
					`--user-data-dir=${desktop}`,
				],
				env,
			});
			try {
				const page = await app.firstWindow();
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				await page.waitForFunction(() => window.omp?.rpc != null);
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 60_000,
					})
					.toBe("ready");
				// The released baseline can race IPC registration during startup.
				// Align both subjects on a ready, empty renderer before timing the switch.
				await page.reload();
				if (errors.length > 0) throw new Error(`Renderer bootstrap failed: ${errors.join("; ")}`);
				const discovered = await page.evaluate(() => window.omp.sessions.list("global"));
				if (!discovered.some(session => session.path === copied)) {
					throw new Error(`Copied session missing from isolated stock index (${discovered.length} sessions)`);
				}
				const codeLane = page.getByRole("tab", { name: "Code", exact: true });
				await expect(codeLane).toBeVisible();
				await codeLane.click();
				const group = page.locator(`button[title=${JSON.stringify(header.cwd)}][aria-expanded]`);
				await expect(group).toBeVisible({ timeout: 30_000 });
				if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
				// Test-only wrapping at the IPC seam counts actual delivered responses,
				// including commandForTab. No production instrumentation or text logs.
				await app.evaluate(({ ipcMain }) => {
					type Handler = (...args: unknown[]) => unknown;
					const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler> | undefined;
					if (!(handlers instanceof Map)) throw new Error("Electron IPC measurement seam unavailable");
					const metrics = { bytes: 0, pages: 0, messages: 0 };
					Reflect.set(globalThis, "ompdeskTranscriptBenchmark", metrics);
					for (const channel of ["rpc:command", "rpc:command-for-tab"]) {
						const original = handlers.get(channel);
						if (!original) throw new Error(`Missing IPC handler ${channel}`);
						handlers.set(channel, async (...args: unknown[]) => {
							const response = await original(...args);
							const command = args
								.map(value =>
									typeof value === "object" && value !== null && "command" in value ? value.command : value,
								)
								.find(
									value =>
										typeof value === "object" &&
										value !== null &&
										"type" in value &&
										(value.type === "get_transcript_page" || value.type === "get_transcript"),
								);
							if (command) {
								metrics.bytes += Buffer.byteLength(JSON.stringify(response), "utf8");
								metrics.pages++;
								const data =
									typeof response === "object" && response !== null && "data" in response
										? response.data
										: undefined;
								if (
									typeof data === "object" &&
									data !== null &&
									"messages" in data &&
									Array.isArray(data.messages)
								)
									metrics.messages += data.messages.length;
							}
							return response;
						});
					}
				});
				const row = page.locator(`[data-session-path=${JSON.stringify(copied)}]`);
				await expect(row).toBeVisible({ timeout: 60_000 });
				await expect(page.locator(`[data-row-key=${JSON.stringify(targetKey)}]`)).toHaveCount(0);
				const cdp = await page.context().newCDPSession(page);
				await cdp.send("HeapProfiler.collectGarbage");
				const beforeHeap = await cdp.send("Runtime.getHeapUsage");
				await page.evaluate(() => performance.mark("transcript-switch-start"));
				await row.click();
				await expect(page.locator(`[data-row-key=${JSON.stringify(targetKey)}]`)).toBeVisible({ timeout: 120_000 });
				await expect(page.locator("[data-switch-pending]")).toHaveCount(0);
				const renderedMs = await page.evaluate(
					() =>
						new Promise<number>(resolve =>
							requestAnimationFrame(() => {
								performance.mark("transcript-switch-rendered");
								resolve(
									performance.measure(
										"transcript-switch",
										"transcript-switch-start",
										"transcript-switch-rendered",
									).duration,
								);
							}),
						),
				);
				const rawHeap = await cdp.send("Runtime.getHeapUsage");
				await cdp.send("HeapProfiler.collectGarbage");
				const retainedHeap = await cdp.send("Runtime.getHeapUsage");
				const transfer = await app.evaluate(
					() =>
						Reflect.get(globalThis, "ompdeskTranscriptBenchmark") as {
							bytes: number;
							pages: number;
							messages: number;
						},
				);
				expect(transfer.pages).toBeGreaterThan(0);
				expect(transfer.bytes).toBeGreaterThan(0);
				expect(transfer.messages).toBeGreaterThan(0);
				results.push({
					subject: subject.name,
					run,
					renderedMs,
					transcriptResponseJsonBytes: transfer.bytes,
					transcriptResponses: transfer.pages,
					transferredMessages: transfer.messages,
					beforeHeapUsedBytes: beforeHeap.usedSize,
					rawHeapUsedBytes: rawHeap.usedSize,
					retainedHeapUsedBytes: retainedHeap.usedSize,
					retainedHeapDeltaBytes: retainedHeap.usedSize - beforeHeap.usedSize,
					mountedRows: await page.locator("[data-transcript-kind]").count(),
					errors,
				});
				await fs.mkdir("test-results", { recursive: true });
				await fs.writeFile("test-results/real-transcript-performance.json", JSON.stringify(results, null, 2));
				await cdp.detach();
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	}
});
