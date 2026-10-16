import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, openDestination } from "./harness";

/**
 * Stand-in for the user's `@oh-my-pi/omp-stats`, loaded by the real
 * resources/gui-bridge/stats-host.ts: `startServer` binds only once the test
 * creates the gate file, so the app sees a stats server that comes up late.
 */
const FAKE_STATS = `
const json = (body: unknown) => Response.json(body);
const OVERVIEW = {
	overall: {
		totalRequests: 1234, successfulRequests: 1200, failedRequests: 34, errorRate: 0.0276,
		totalInputTokens: 500000, totalOutputTokens: 120000, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
		cacheRate: 0, totalCost: 12.5, avgDuration: 1800, avgTtft: 400, avgTokensPerSecond: 72,
	},
	byAgentType: [{ agentType: "late-bound-agent", totalRequests: 1234, totalInputTokens: 500000,
		totalOutputTokens: 120000, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCost: 12.5 }],
	timeSeries: [],
};
const SYNC = { sync: { phase: "idle", current: 0, total: 0, lastSyncedAt: 1 } };
export async function startServer(port: number, hostname: string) {
	const gate = process.env.OMP_GUI_TEST_STATS_GATE ?? "";
	const { promise, resolve } = Promise.withResolvers<void>();
	const poll = setInterval(async () => {
		if (await Bun.file(gate).exists()) resolve();
	}, 100);
	await promise;
	clearInterval(poll);
	const server = Bun.serve({
		port,
		hostname,
		fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname === "/api/stats/overview") return json(OVERVIEW);
			if (pathname === "/api/sync" || pathname === "/api/status") return json(SYNC);
			return json({});
		},
	});
	return { hostname, port: server.port, stop: () => server.stop(true) };
}
export const formatStatsDashboardUrl = (hostname: string, port: number) => \`http://\${hostname}:\${port}\`;
export function closeDb() {}
`;

test("a stats server that binds late fills the open stats page with no reload", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-late-"));
	const desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	execFileSync("git", ["init", "--quiet"], { cwd: project });
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const bin = await fixtureOmp(profile);
	const modules = path.join(path.dirname(bin), "node_modules", "@oh-my-pi");
	const stats = path.join(modules, "omp-stats");
	await fs.mkdir(stats, { recursive: true });
	await fs.writeFile(
		path.join(stats, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/omp-stats",
			type: "module",
			exports: { ".": "./index.ts", "./db": "./rest.ts", "./aggregator": "./rest.ts" },
		}),
	);
	await fs.writeFile(path.join(stats, "index.ts"), FAKE_STATS);
	await fs.writeFile(path.join(stats, "rest.ts"), "export function getTimeRangeConfig() { return {}; }\n");
	// stats-host also loads stock's frustration judge from the agent package.
	const agentPackage = path.join(modules, "pi-coding-agent");
	const manifest = JSON.parse(await fs.readFile(path.join(agentPackage, "package.json"), "utf8"));
	manifest.exports["./judgment/standalone"] = "./judgment.ts";
	await fs.writeFile(path.join(agentPackage, "package.json"), JSON.stringify(manifest));
	await fs.writeFile(
		path.join(agentPackage, "judgment.ts"),
		"export async function openStandaloneJudge() { return { judge: null }; }\n",
	);
	const gate = path.join(profile, "stats-gate");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: bin,
		OMP_GUI_TEST_STATS_GATE: gate,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await openDestination(page, "insights");
		const insights = page.locator('section[data-destination="insights"]');
		await insights.getByRole("tab", { name: "All sessions", exact: true }).click();
		// Down within seconds, not after the restart ladder gives up.
		await expect(insights.getByText("The stats server isn't answering", { exact: true })).toBeVisible({
			timeout: 20_000,
		});
		await fs.writeFile(gate, "");
		// No reload and no Retry click: the section's background reads pick the server up.
		await expect(insights.getByText("late-bound-agent", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(insights.getByText("The stats server isn't answering", { exact: true })).toHaveCount(0);
		await page.screenshot({ animations: "disabled", path: test.info().outputPath("stats-late-filled.png") });
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
