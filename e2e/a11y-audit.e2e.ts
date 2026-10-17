/**
 * Keyboard and axe-core pass over every major surface of the app (fake omp):
 * the session window, command palette, panel views, Agents / Stats pages and
 * every Settings section, in en and ko, light and dark. Tab stops must show a
 * focus indicator, Escape must close what opened, and axe finds no violation
 * at all (rules that cannot hold in this app are listed with the reason).
 *
 * `OMP_GUI_A11Y_REPORT=<dir>` writes every finding as JSON for a review
 * instead of failing on the first one.
 */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, openDestination, variants } from "./harness";

const REPORT = process.env.OMP_GUI_A11Y_REPORT ?? "";
const AXE_SOURCE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface Finding {
	surface: string;
	kind: string;
	detail: string;
}

async function launch(
	language: "en" | "ko",
	theme: "light" | "dark",
): Promise<{ app: ElectronApplication; page: Page }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-a11y-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const app = await launchApp({ project, desktop, agent, profile });
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	return { app, page };
}

/** Axe rules switched off, each with the reason it cannot hold here. */
const AXE_OFF: Record<string, string> = {
	// The window is an Electron shell: the page has one <main> per route but no skip-link target.
	region: "content outside landmarks is the title bar's drag region",
};

async function axeScan(page: Page, surface: string, findings: Finding[]): Promise<void> {
	// Reduced motion collapses entrance fades and slides (global.css), so axe never scores a mid-transition blend.
	// A title still fading in (a slow runner draws it late) is a blend of its colours: let finite animations end first.
	await page
		.waitForFunction(
			() =>
				document
					.getAnimations()
					.every(
						animation =>
							animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running",
					),
			undefined,
			{ timeout: 5_000 },
		)
		.catch(() => undefined);
	await page.evaluate(await fs.readFile(AXE_SOURCE, "utf8"));
	const violations = await page.evaluate(async off => {
		interface AxeResult {
			id: string;
			impact: string | null;
			help: string;
			nodes: { target: unknown[]; html: string; any: { message: string }[] }[];
		}
		interface AxeApi {
			run: (context: Document, options: object) => Promise<{ violations: AxeResult[] }>;
		}
		// axe-core was injected as a page global just above; it has no module types in the page.
		const axe = (window as unknown as { axe: AxeApi }).axe;
		const result = await axe.run(document, {
			rules: Object.fromEntries(off.map(id => [id, { enabled: false }])),
			resultTypes: ["violations"],
		});
		return result.violations.map(v => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			nodes: v.nodes.slice(0, 6).map(n => ({
				target: n.target.join(" "),
				html: n.html.slice(0, 160),
				message: n.any.map(check => check.message).join("; "),
			})),
		}));
	}, Object.keys(AXE_OFF));
	for (const v of violations)
		findings.push({
			surface,
			kind: `axe:${v.id}:${v.impact}`,
			detail: `${v.help} — ${v.nodes.map(n => `${n.target} ${n.html} [${n.message}]`).join(" | ")}`,
		});
}

/**
 * Whether the focused element paints anything: a ring can sit on a pseudo-element or a wrapper
 * (`focus-visible:after:…`, `focus-within`), where computed style of the element itself says nothing.
 * Compares the padded box with and without focus.
 */
async function paintsFocus(page: Page): Promise<boolean> {
	const box = await page.evaluate(() => {
		const el = document.activeElement;
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		const pad = 8;
		const x = Math.max(0, rect.x - pad);
		const y = Math.max(0, rect.y - pad);
		return { x, y, width: Math.min(rect.width + 2 * pad, 600), height: Math.min(rect.height + 2 * pad, 300) };
	});
	if (!box || box.width < 1 || box.height < 1) return true;
	const focused = await page.screenshot({ clip: box, animations: "disabled" });
	await page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null; // focused node is always an element
		el?.setAttribute("data-a11y-probe", "");
		el?.blur();
	});
	const plain = await page.screenshot({ clip: box, animations: "disabled" });
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-a11y-probe]");
		el?.removeAttribute("data-a11y-probe");
		el?.focus({ focusVisible: true } as FocusOptions);
	});
	return !focused.equals(plain);
}

/** Tab through the page; every stop must be visibly focused. */
async function tabWalk(page: Page, surface: string, findings: Finding[], limit = 60): Promise<string[]> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	const stops: string[] = [];
	for (let step = 0; step < limit; step++) {
		await page.keyboard.press("Tab");
		const stop = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null; // the focused node is always an element
			if (!el || el === document.body) return null;
			const style = getComputedStyle(el);
			const name =
				el.getAttribute("aria-label") ??
				el.getAttribute("title") ??
				(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
			const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
			const shadow = style.boxShadow !== "none";
			const id = `${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] ${name}`;
			if (!el.matches(":focus-visible"))
				return { id, visible: false, hidden: false, outlineStyle: "not :focus-visible", boxShadow: "" };
			return {
				id,
				visible: outline || shadow,
				outlineStyle: style.outlineStyle,
				boxShadow: `${style.boxShadow.slice(0, 40)} outlineWidth=${style.outlineWidth} color=${style.outlineColor} class=${String(el.className).slice(0, 140)}`,
				hidden: style.visibility === "hidden" || el.getClientRects().length === 0,
			};
		});
		if (!stop) continue;
		stops.push(stop.id);
		if (stop.hidden) findings.push({ surface, kind: "tab:hidden-stop", detail: stop.id });
		// The composer field shows focus with its caret and the box's border/shadow (components.css `.omp-composer-box:has(textarea:focus)`) by design: no accent halo on a field that stays focused.
		else if (!stop.visible && !stop.boxShadow.includes("omp-composer-input") && !(await paintsFocus(page)))
			findings.push({
				surface,
				kind: "tab:no-focus-indicator",
				detail: `${stop.id} (${stop.boxShadow})`,
			});
		if (stop.id === stops[0] && stops.length > 3) break;
	}
	return stops;
}

for (const [language, theme] of variants([
	["en", "light"],
	["ko", "dark"],
] as const))
	test(`a11y audit (${language} ${theme})`, async () => {
		test.setTimeout(600_000);
		const findings: Finding[] = [];
		const { app, page } = await launch(language, theme);
		try {
			// The test window is never focused (OMP_GUI_HEADLESS), so :focus-visible only matches with focus emulation.
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
			await page.emulateMedia({ reducedMotion: "reduce" });
			const scan = async (surface: string) => {
				await axeScan(page, surface, findings);
				await tabWalk(page, surface, findings);
			};
			const scanTabs = async (surface: string, scope: Locator) => {
				for (let index = 0; index < (await scope.getByRole("tab").count()); index++) {
					const tab = scope.getByRole("tab").nth(index);
					const name = ((await tab.textContent()) ?? `tab ${index}`).trim();
					await tab.click({ timeout: 5_000 });
					await expect(scope.getByRole("tab").nth(index)).toHaveAttribute("aria-selected", "true");
					await expect(page.locator(".animate-spin")).toHaveCount(0, { timeout: 15_000 });
					await scan(`${surface} › ${name}`);
				}
			};
			await expect(page.locator(".omp-composer-input").first()).toBeVisible();
			await scan("session");

			await page.keyboard.press("Meta+k");
			await expect(page.getByRole("dialog")).toBeVisible();
			await scan("palette");
			await page.keyboard.press("Escape");
			if ((await page.getByRole("dialog").count()) > 0)
				findings.push({ surface: "palette", kind: "escape:not-closed", detail: "dialog stays after Escape" });

			await page.keyboard.press("Meta+j");
			const aside = page.locator("aside[data-docked]");
			await expect(aside).toBeVisible();
			await scan("panel");
			for (const view of await aside
				.locator("header button[aria-label]")
				.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? ""))) {
				if (/close|닫기|options|옵션/i.test(view)) continue;
				await aside.locator(`header button[aria-label="${view}"]`).click();
				await expect(page.locator("aside[data-docked] .animate-spin")).toHaveCount(0, { timeout: 15_000 });
				await scan(`panel › ${view}`);
			}
			await page.keyboard.press("Meta+j");

			for (const dest of ["agents", "insights"] as const) {
				await openDestination(page, dest);
				await expect(page.locator("main .animate-spin")).toHaveCount(0, { timeout: 15_000 });
				await scan(`page-${dest}`);
				await scanTabs(`page-${dest}`, page.locator("main"));
			}

			await page.keyboard.press("Meta+,");
			const settings = page.locator("[data-settings-page]");
			await expect(settings).toBeVisible();
			const sections = await settings
				.locator("[data-settings-section]")
				.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section") ?? ""));
			for (const section of sections) {
				await settings.locator(`[data-settings-section="${section}"]`).click();
				await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
				await scan(`settings-${section}`);
				// Compact rows: every info glyph is a named button, every row icon is decorative.
				const compact = await settings.locator(".settings-content").evaluate(root => ({
					unnamedInfo: [...root.querySelectorAll("[data-setting-info]")].filter(
						button => !button.getAttribute("aria-label"),
					).length,
					loudIcons: [...root.querySelectorAll("[data-setting-icon]")].filter(
						icon => icon.getAttribute("aria-hidden") !== "true",
					).length,
				}));
				expect(compact, `compact rows in settings-${section}`).toEqual({ unnamedInfo: 0, loudIcons: 0 });
				// A long description is reachable from the keyboard: focusing its glyph shows it.
				if (section === "general") {
					const glyph = settings.locator("[data-setting-info]").first();
					await glyph.focus();
					await page.keyboard.press("Shift+Tab");
					await page.keyboard.press("Tab");
					await expect(page.getByRole("tooltip")).toBeVisible();
				}
				await scanTabs(`settings-${section}`, settings.locator(".settings-content"));
			}
			await page.keyboard.press("Escape");
		} finally {
			await exitApp(app);
		}
		if (REPORT) {
			await fs.mkdir(REPORT, { recursive: true });
			await fs.writeFile(path.join(REPORT, `${language}-${theme}.json`), JSON.stringify(findings, null, 1));
		} else {
			expect(findings).toEqual([]);
		}
	});
