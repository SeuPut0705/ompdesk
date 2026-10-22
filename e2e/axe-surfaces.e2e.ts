import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { type Look, openLook, resetPage } from "./responsive-audit";
import { surfacesFor } from "./responsive-surfaces";

// axe-core over every surface of e2e/responsive-surfaces.ts on the dev harness, one test per look. Registered only
// with OMP_GUI_AXE=<dir> (writes <dir>/<look>.json, every violation with its nodes). Looks: OMP_GUI_AXE_LOOKS, a
// comma list of `<width>-<theme>-<lang>` (390 and 412 are a phone, anything wider the Electron window), default
// 1280-light-en,1280-dark-en,390-light-ko,390-dark-en; OMP_GUI_AXE_ONLY=<regex of surface ids> narrows the surfaces.
// A violation fails the look unless ALLOWED names it with the reason. Run it under `bun run locked`.
// e2e/a11y-audit.e2e.ts is the real app's keyboard and axe pass over the main surfaces; this reaches the cards,
// sheets, dialogs and board states only the harness can put on screen.

const dir = process.env.OMP_GUI_AXE;
const AXE_SOURCE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Rule off for the whole page, with why it cannot hold here. */
const OFF: Record<string, string> = {
	region: "the title bar is the window's drag region, content no landmark holds",
};

/** A rule allowed on one element, with why. */
const ALLOWED: Array<{ rule: string; target: RegExp; why: string }> = [
	{
		rule: "aria-allowed-role",
		target: /^textarea$/,
		why: "the composer is a combobox while its completion menu is open (DI-8): Chromium exposes it, and dropping the role drops aria-expanded",
	},
];

interface Violation {
	id: string;
	nodes: Array<{ target: string; summary: string }>;
}

function parseLook(spec: string): Look {
	const [width, theme, lang] = spec.split("-");
	const phone = Number(width) <= 430;
	return {
		width: Number(width),
		height: phone ? 844 : 800,
		dpr: phone ? 3 : 1,
		orientation: phone ? "portrait" : "landscape",
		theme: theme as Look["theme"],
		lang: lang as Look["lang"],
		device: phone ? "touch" : "electron",
	};
}

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

if (dir) {
	test.describe.configure({ retries: 0, timeout: 20 * 60_000 });
	let server: ViteDevServer | undefined;
	let browser: Browser | undefined;
	let origin = "";

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

	const looks = (process.env.OMP_GUI_AXE_LOOKS ?? "1280-light-en,1280-dark-en,390-light-ko,390-dark-en").split(",");
	const only = process.env.OMP_GUI_AXE_ONLY ? new RegExp(process.env.OMP_GUI_AXE_ONLY) : undefined;
	for (const spec of looks) {
		test(`axe ${spec}`, async () => {
			const look = parseLook(spec);
			const report: Array<{ surface: string; failed?: string; violations?: Violation[] }> = [];
			const groups = new Map<string, ReturnType<typeof surfacesFor>>();
			for (const surface of surfacesFor({ only })) {
				if (surface.when && !surface.when(look)) continue;
				const query = surface.query ?? "";
				groups.set(query, [...(groups.get(query) ?? []), surface]);
			}
			for (const [query, surfaces] of groups) {
				let page = await openLook(browser as Browser, look, { origin, query });
				for (const surface of surfaces) {
					try {
						await surface.open(page, look);
						if (surface.ready) await page.locator(surface.ready).first().waitFor({ state: "visible" });
						await page.waitForTimeout(surface.settle ?? 400);
						if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_SOURCE });
						const violations = await page.evaluate(async off => {
							const rules = Object.fromEntries(off.map(id => [id, { enabled: false }]));
							// @ts-expect-error axe is the script tag's global
							const result = await window.axe.run(document, { resultTypes: ["violations"], rules });
							return result.violations.map(
								(v: { id: string; nodes: { target: string[]; failureSummary: string }[] }) => ({
									id: v.id,
									nodes: v.nodes.map(node => ({
										target: node.target.join(" "),
										summary: node.failureSummary,
									})),
								}),
							);
						}, Object.keys(OFF));
						const kept = (violations as Violation[])
							.map(violation => ({
								...violation,
								nodes: violation.nodes.filter(
									node =>
										!ALLOWED.some(
											allowed => allowed.rule === violation.id && allowed.target.test(node.target),
										),
								),
							}))
							.filter(violation => violation.nodes.length > 0);
						report.push({ surface: surface.id, violations: kept });
					} catch (error) {
						report.push({ surface: surface.id, failed: String(error).slice(0, 300) });
					}
					if (!(await resetPage(page).catch(() => false))) {
						await page.context().close();
						page = await openLook(browser as Browser, look, { origin, query });
					}
				}
				await page.context().close();
			}
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, `${spec}.json`), JSON.stringify(report, null, 1));
			// A surface that did not open was not checked: it fails the look as a violation does.
			const found = report.flatMap(entry =>
				entry.failed
					? [`${entry.surface}: did not open (${entry.failed})`]
					: (entry.violations ?? []).map(
							violation => `${entry.surface}: ${violation.id} ${violation.nodes[0]?.target}`,
						),
			);
			expect(found, `axe violations at ${spec} (details in ${dir}/${spec}.json)`).toEqual([]);
		});
	}
}
