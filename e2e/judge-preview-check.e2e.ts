import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The judge-model preview check (src/main/preview/preview-check.ts) on the built app and the fake omp
// (`OMP_GUI_TEST_JUDGE_ASSIST` makes its judge decide). With a native judge that sees an error, the visual's page gets
// the notice and the gui_visualize result the hint; without one, the result and the Preview are as before. The rules
// themselves (thresholds, privacy, timeouts) are pinned by preview-check.test.ts and the "Preview check" cases of
// preview/host.test.ts.

interface Frame {
	type?: string;
	result?: unknown;
}

for (const judge of ["error", "none"] as const) {
	test(`gui_visualize: preview check with ${judge === "error" ? "a native judge seeing an error" : "no native judge"}`, async () => {
		test.setTimeout(90_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-judge-preview-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		const record = path.join(profile, "record.jsonl");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
		);
		await fs.writeFile(path.join(project, "page.html"), "<!doctype html><title>Page</title><h1>Hello</h1>");
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: await fixtureOmp(profile),
			OMP_GUI_TEST_RECORD: record,
			...(judge === "error" ? { OMP_GUI_TEST_JUDGE_ASSIST: JSON.stringify({ preview: "error" }) } : {}),
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
			env,
		});
		const shell = await app.firstWindow();
		const results = async () =>
			(await fs.readFile(record, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Frame)
				.filter(frame => frame.type === "host_tool_result")
				.map(frame => JSON.stringify(frame.result));
		try {
			await shell.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await shell.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const composer = shell.locator("textarea").first();
			await composer.fill(
				`!fixture:host-tool:gui_visualize ${JSON.stringify({ action: "open", target: "page.html" })}`,
			);
			await composer.press("Enter");
			await expect.poll(async () => (await results()).join("\n"), { timeout: 20_000 }).toContain("Showing");
			const result = (await results()).join("\n");
			const notice = shell.locator("aside[data-docked] [data-preview-check]");
			if (judge === "error") {
				expect(result).toContain("Preview check: the page shows an error message.");
				await expect(notice).toHaveAttribute("data-preview-check", "error");
			} else {
				expect(result).not.toContain("Preview check");
				await expect(shell.locator("aside[data-docked]")).toBeVisible();
				await expect(notice).toHaveCount(0);
			}
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
