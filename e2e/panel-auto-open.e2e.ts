import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The side panel opening by itself on the fake omp's `fixture flow` run: a dev server's address
// opens the Preview (once per address, never over a view the user works in).
test.describe.configure({ mode: "parallel" });

interface Launched {
	app: ElectronApplication;
	page: Page;
	tab: string;
}

async function launch(root: string, prefs: Record<string, unknown> = {}): Promise<Launched> {
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir, { recursive: true })));
	// A checkout with an uncommitted edit, so Changes has something to show.
	const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "e2e@example.com");
	git("config", "user.name", "e2e");
	await fs.writeFile(path.join(project, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	await fs.writeFile(path.join(project, "a.txt"), "one\ntwo\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, ...prefs }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
	if (!tab) throw new Error("No active tab");
	return { app, page, tab };
}

function driver(page: Page, tab: string) {
	const op = async (spec: Record<string, unknown>) => {
		const response = await page.evaluate(
			([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }),
			[tab, `fixture:flow:${JSON.stringify(spec)}`] as const,
		);
		if (!response.success) throw new Error(`flow op ${JSON.stringify(spec)}: ${response.error}`);
	};
	const start = async () => {
		const input = page.locator("textarea").first();
		await input.fill("fixture flow");
		await input.press("Enter");
		await page.waitForTimeout(300);
	};
	return { op, start };
}

const PREVIEW_ADDRESS = "Preview URL";
const panel = (page: Page) => page.locator("aside.omp-inspector");

async function withApp(prefs: Record<string, unknown>, body: (launched: Launched) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-auto-open-"));
	const launched = await launch(root, prefs);
	try {
		await body(launched);
	} finally {
		await exitApp(launched.app);
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("a dev server's address opens the Preview, once per address", async () => {
	await withApp({}, async ({ page, tab }) => {
		const flow = driver(page, tab);
		await expect(panel(page)).toHaveCount(0);
		await flow.start();
		await flow.op({ op: "call", id: "dev", name: "bash", args: { command: "npm run dev" } });
		await flow.op({ op: "output", id: "dev", text: "VITE ready in 300 ms\n  Local: http://localhost:5173/" });
		await expect(panel(page)).toBeVisible();
		await expect(panel(page).getByLabel(PREVIEW_ADDRESS)).toHaveValue(/localhost:5173/);
		// The user closes it; the same address again keeps it closed.
		await page.getByRole("button", { name: "Close side panel" }).click();
		await expect(panel(page)).toHaveCount(0);
		await flow.op({ op: "output", id: "dev", text: "hmr update\n  Local: http://localhost:5173/" });
		await page.waitForTimeout(800);
		await expect(panel(page)).toHaveCount(0);
		await flow.op({ op: "end", id: "dev", text: "stopped" });
		await flow.op({ op: "reply", text: "done" });
	});
});

test("the switch turns the dev server Preview off", async () => {
	await withApp({ autoPreviewDevServer: false }, async ({ page, tab }) => {
		const flow = driver(page, tab);
		await flow.start();
		await flow.op({ op: "call", id: "dev", name: "bash", args: { command: "npm run dev" } });
		await flow.op({ op: "output", id: "dev", text: "  Local: http://localhost:5173/" });
		await page.waitForTimeout(1200);
		await expect(panel(page)).toHaveCount(0);
		await flow.op({ op: "end", id: "dev", text: "stopped" });
		await flow.op({ op: "reply", text: "done" });
	});
});
