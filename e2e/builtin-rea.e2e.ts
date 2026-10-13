import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { z } from "zod";
import { REA_MOUNTED_TOOL_COUNT, REA_VERSION } from "../src/shared/builtin-mcp";
import { exitApp, fixtureOmp } from "./harness";
import { realOmpProfile } from "./real-omp";

const Servers = z.object({
	servers: z.array(
		z.object({
			name: z.string(),
			status: z.string(),
			toolCount: z.number(),
			builtin: z.literal("rea").optional(),
		}),
	),
});
const Tool = z.object({ name: z.string(), description: z.string().optional() });
const ActiveTools = z.object({ tools: z.array(Tool) });
const SessionTools = z.object({
	dumpTools: z.array(Tool).optional(),
	systemPrompt: z.array(z.string()).optional(),
	sessionFile: z.string().nullable().optional(),
});

async function launch(fake: boolean) {
	const isolated = fake ? undefined : await realOmpProfile();
	const profile = isolated?.profile ?? (await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-rea-")));
	const project = isolated?.project ?? path.join(profile, "project");
	const desktop = isolated?.desktop ?? path.join(profile, "desktop");
	const agent = isolated?.agent ?? path.join(profile, "agent");
	const cache = path.join(profile, "npm-cache");
	if (fake) await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent, { mode: 0o700 })]);
	await fs.mkdir(cache);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
		}),
	);
	const env = {
		...(isolated?.env ?? process.env),
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		npm_config_cache: cache,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	if (fake) Object.assign(env, { OMP_GUI_OMP: await fixtureOmp(profile) });
	const started = performance.now();
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
		.toMatchObject({ status: "ready" });
	return { profile, app, page, started, readyMs: performance.now() - started };
}

test("Settings shows the built-in REA entry and stores its new-session toggle", async () => {
	const { profile, app, page } = await launch(true);
	try {
		await page.keyboard.press("ControlOrMeta+Comma");
		const settingsPage = page.locator("[data-settings-page]");
		await settingsPage.locator('[data-settings-section="tools"]').click();
		await settingsPage.getByRole("tab", { name: /^MCP servers/ }).click();
		const entry = page.locator("[data-builtin-rea]");
		await expect(entry).toBeVisible();
		await expect(entry).toContainText("REA — reverse engineering (built in)");
		await expect(entry).toContainText(REA_VERSION);
		await expect(entry).toContainText("15 curated");
		await expect(entry).toContainText("full catalog available on demand");
		await expect(entry).toContainText("Changes apply to new sessions");
		await expect(entry.getByRole("switch")).toBeEnabled();
		await entry.getByRole("switch").click();
		await expect(entry.getByRole("switch")).toHaveAttribute("aria-checked", "false");
		expect(await page.evaluate(() => window.omp.prefs.get("builtinMcp.rea"))).toBe(false);
		await expect(page.locator("[data-builtin-rea]")).toContainText("Node.js ^22.19.0 || ^24.11.0 || >=26.0.0");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("real stock omp mounts the curated relay and uses catalog discovery on the small model", async () => {
	const testInfo = test.info();
	test.skip(process.env.OMP_GUI_REAL_REA !== "1", "Opt-in isolated npm download and small-model request");
	test.setTimeout(420_000);
	const { profile, app, page, started, readyMs } = await launch(false);
	try {
		const availability = await page.evaluate(() => window.omp.builtinRea.get());
		expect(availability).toMatchObject({ enabled: true, available: true });
		const atReady = await page.evaluate(() => window.omp.rpc.getMcpServers());
		await expect
			.poll(
				async () => {
					const reply = await page.evaluate(() => window.omp.rpc.getMcpServers());
					return reply.success
						? Servers.parse(reply.data).servers.find(server => server.builtin === "rea")
						: reply;
				},
				{ timeout: 240_000, intervals: [100, 250, 500, 1000] },
			)
			.toMatchObject({ name: "rea", status: "connected", toolCount: REA_MOUNTED_TOOL_COUNT });
		const connectedMs = performance.now() - started;
		const servers = await page.evaluate(() => window.omp.rpc.getMcpServers());
		const rea = Servers.parse(servers.data).servers.find(server => server.builtin === "rea");
		expect(rea?.toolCount).toBe(REA_MOUNTED_TOOL_COUNT);
		const tools = await page.evaluate(() => window.omp.rpc.getActiveTools());
		const mounted = ActiveTools.parse(tools.data).tools.filter(tool => tool.name.startsWith("mcp__rea_"));
		expect(mounted).toHaveLength(rea?.toolCount ?? -1);
		expect(mounted.map(tool => tool.name)).toContain("mcp__rea_catalog");
		expect(mounted.map(tool => tool.name)).toContain("mcp__rea_call");
		const state = await page.evaluate(() => window.omp.rpc.getState());
		const session = SessionTools.parse(state.data);
		expect((session.dumpTools ?? []).filter(tool => tool.name.startsWith("mcp__rea_"))).toHaveLength(0);
		expect(session.systemPrompt?.join("\n")).toContain("mcp__rea_");
		expect(session.systemPrompt?.join("\n")).toContain("docs on demand");
		const settings = await page.evaluate(() =>
			window.omp.rpc.getSettings(["tools.xdevDocs", "mcp.startupTimeoutMs"]),
		);
		expect(settings.data).toMatchObject({ values: { "tools.xdevDocs": "catalog", "mcp.startupTimeoutMs": 250 } });
		const input = page.locator("textarea").first();
		await input.fill(
			"Use rea_catalog (via its xd:// device) to search the full REA catalog for the JavaScript application analysis entry tool. Do not analyze any files. Report the exact tool name from the catalog result, and nothing else.",
		);
		await input.press("Enter");
		await expect(page.getByPlaceholder(/Steer omp/)).toBeVisible({ timeout: 60_000 });
		await expect(page.getByPlaceholder(/Ask omp anything/)).toBeVisible({ timeout: 180_000 });
		const finalState = await page.evaluate(() => window.omp.rpc.getState());
		const sessionFile = SessionTools.parse(finalState.data).sessionFile;
		if (!sessionFile?.startsWith(profile)) throw new Error("Expected an isolated REA session file");
		const savedSession = await fs.readFile(sessionFile, "utf8");
		const rows = savedSession
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as unknown);
		const Entry = z
			.object({
				message: z.object({ role: z.string(), customType: z.string().optional(), content: z.unknown() }).optional(),
			})
			.passthrough();
		const notices = rows
			.map(row => Entry.parse(row).message)
			.filter(message => message?.customType === "xdev-mount-notice");
		const noticeText = notices
			.map(message => (typeof message?.content === "string" ? message.content : JSON.stringify(message?.content)))
			.join("\n");
		const noticeBytes = Buffer.byteLength(noticeText);
		const reaCatalogBytes = Buffer.byteLength(
			session.systemPrompt
				?.join("\n")
				.split("\n")
				.filter(line => line.includes("xd://mcp__rea_"))
				.join("\n") ?? "",
		);
		expect(savedSession).toContain("analyze_javascript_application");
		expect(savedSession).toContain("rea_catalog");
		// A successful discovery response contains the catalog's real description,
		// not merely the model repeating the tool name from its mount notice.
		const catalogResults = rows
			.map(row => Entry.parse(row).message)
			.filter(
				message =>
					message?.role === "toolResult" && JSON.stringify(message.content).includes("Reconstruct one local ASAR"),
			);
		expect(catalogResults.length).toBeGreaterThan(0);
		expect(noticeBytes).toBeLessThan(12_000);
		const evidence = {
			availability,
			readyMs,
			connectedMs,
			atReady,
			servers,
			mounted,
			settings,
			state,
			beforeApproximateNoticeBytes: 45_000,
			noticeBytes,
			reaCatalogBytes,
			mountedCount: mounted.length,
			sessionFile,
			savedSession,
			catalogResults,
		};
		await fs.writeFile(testInfo.outputPath("rea-real-evidence.json"), JSON.stringify(evidence, null, 2));
		if (process.env.OMP_GUI_REA_EVIDENCE) {
			await fs.writeFile(process.env.OMP_GUI_REA_EVIDENCE, JSON.stringify(evidence, null, 2));
		}
		console.log(
			"REA cold-cache evidence",
			JSON.stringify({
				readyMs,
				connectedMs,
				nodeVersion: availability.nodeVersion,
				atReady: Servers.parse(atReady.data).servers.find(server => server.builtin === "rea"),
				connected: rea,
				mountedCount: mounted.length,
				noticeBytes,
				reaCatalogBytes,
				catalogLines: session.systemPrompt
					?.join("\n")
					.split("\n")
					.filter(line => line.includes("xd://mcp__rea_")).length,
			}),
		);
		await testInfo.attach("REA real stock evidence", {
			body: JSON.stringify(evidence, null, 2),
			contentType: "application/json",
		});
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
