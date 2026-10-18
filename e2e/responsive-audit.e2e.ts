import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import {
	crashed,
	type Look,
	looksFor,
	lookTag,
	measure,
	measureDensity,
	mergeReport,
	openLook,
	resetPage,
	type SurfaceResult,
	summarize,
	writeLook,
} from "./responsive-audit";
import { type Surface, surfacesFor } from "./responsive-surfaces";

// The full responsive matrix: every surface of e2e/responsive-surfaces.ts at every look of e2e/responsive-audit.ts.
// Registered only with OMP_GUI_RESPONSIVE=<dir> (it writes <dir>/report.json, <dir>/summary.md, <dir>/looks/*.json
// and captures under <dir>/shots). Narrow it with OMP_GUI_RESPONSIVE_WIDTHS=390,834, _LANGS=en, _THEMES=light,
// _ORIENT=portrait, _AREA=A|B, _ONLY=<regex of surface ids>, and OMP_GUI_RESPONSIVE_SHOTS=all|none (default: 390
// and 834, en, light). Run it under `bun run locked`.

const dir = process.env.OMP_GUI_RESPONSIVE;
const list = (name: string): string[] | undefined => process.env[name]?.split(",").filter(Boolean);

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
	});
	return promise;
}

async function shouldShoot(look: Look): Promise<boolean> {
	const mode = process.env.OMP_GUI_RESPONSIVE_SHOTS;
	if (mode === "none") return false;
	if (mode === "all") return true;
	return look.lang === "en" && look.theme === "light" && (look.width === 390 || look.width === 834);
}

if (dir) {
	test.describe.configure({ retries: 0, timeout: 40 * 60_000 });

	test.beforeAll(async () => {
		const port = await freePort();
		server = await createServer({
			configFile: path.resolve("vite.harness.config.ts"),
			server: { host: "127.0.0.1", port, strictPort: true },
			logLevel: "error",
		});
		await server.listen();
		origin = `http://127.0.0.1:${port}`;
		browser = await chromium.launch();
	});

	test.afterAll(async () => {
		await browser?.close();
		await server?.close();
	});

	const looks = looksFor({
		widths: list("OMP_GUI_RESPONSIVE_WIDTHS")?.map(Number),
		langs: list("OMP_GUI_RESPONSIVE_LANGS") as Look["lang"][] | undefined,
		themes: list("OMP_GUI_RESPONSIVE_THEMES") as Look["theme"][] | undefined,
		orientations: list("OMP_GUI_RESPONSIVE_ORIENT"),
	});
	const only = process.env.OMP_GUI_RESPONSIVE_ONLY ? new RegExp(process.env.OMP_GUI_RESPONSIVE_ONLY) : undefined;
	const surfaces = surfacesFor({ area: process.env.OMP_GUI_RESPONSIVE_AREA, only });

	for (const look of looks) {
		test(`responsive ${lookTag(look)}`, async () => {
			if (!browser || !dir) throw new Error("the audit's browser is not up");
			const results: SurfaceResult[] = [];
			const groups = new Map<string, Surface[]>();
			for (const surface of surfaces)
				groups.set(surface.query ?? "", [...(groups.get(surface.query ?? "") ?? []), surface]);
			for (const [query, group] of groups) {
				let page = await openLook(browser, look, { origin, query });
				let reload = false;
				for (const surface of group) {
					if (surface.when && !surface.when(look)) continue;
					if (reload || !(await resetPage(page))) {
						await page.context().close();
						page = await openLook(browser, look, { origin, query });
						reload = false;
					}
					let failed: string | undefined;
					try {
						await surface.open(page, look);
						if (surface.ready)
							await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 8_000 });
						await page.waitForTimeout(surface.settle ?? 450);
					} catch (error) {
						failed = error instanceof Error ? error.message.split("\n")[0] : String(error);
					}
					if (await crashed(page)) {
						const message = await page
							.locator("main pre")
							.first()
							.innerText({ timeout: 2_000 })
							.catch(() => "");
						failed = `crashed the renderer: ${message.slice(0, 300) || failed || "?"}`;
						reload = true;
					}
					const issues = failed ? [] : await measure(page, look);
					const metrics = surface.density && !failed ? await measureDensity(page, look) : undefined;
					results.push(summarize(surface, look, issues, failed, metrics));
					if (await shouldShoot(look)) {
						const shots = path.join(dir, "shots");
						await fs.mkdir(shots, { recursive: true });
						await page.screenshot({
							path: path.join(shots, `${lookTag(look)}-${surface.id}.png`),
							animations: "disabled",
						});
					}
				}
				await page.context().close();
			}
			await writeLook(dir, look, results);
			await mergeReport(dir);
		});
	}
}
