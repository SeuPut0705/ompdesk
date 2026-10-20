/**
 * Built-in pstack engineering mode on the fake omp. The fake emulates the one thing a real omp does with the pack: it
 * lists the skills of every `-e` root (`OMP_GUI_TEST_PSTACK=1`), and its context inspector shows the bridge's `pstack`
 * section decided by the packaged gating rules (`modes/pstack-core.ts`, imported by the fake, not copied):
 * - on by default: the spawn carries the pack root, the skill list shows the pstack skills (hidden from the model's
 *   list, readable by `skill://`), no stock-named `tdd`/`teach`, and a Code session's main agent has the section;
 * - Plan mode and an Autopilot run leave the full section out; Solo delegation flips its delegation paragraph;
 * - the switch off (pref `pstack`): no pack root, no pstack skills, no section;
 * - the ECC pack (`resources/omp-builtin/ecc`) rides its own switch (pref `ecc`): its root and its listed index skill
 *   with every other ECC skill hidden, gone when off. What the real omp does with that root is
 *   `src/main/ecc/ecc-stock.test.ts`.
 * The same gating on the real bridge code is `src/main/bridge-pstack.test.ts` (subagents included).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { cleanupAp, command, launchAp, mainTab, makeApProfile, startRun, waitForStatus } from "./autopilot-harness";
import { exitApp, launchApp, recordsOfType } from "./harness";

const Inspected = z.object({ entries: z.array(z.object({ id: z.string(), label: z.string() })) });
const EntryText = z.object({ text: z.string() });
const Skills = z.object({ skills: z.array(z.object({ name: z.string(), hidden: z.boolean() })) });

async function launch(prefs: Record<string, unknown>) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-pstack-")));
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	const record = path.join(root, "rpc.jsonl");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, ...prefs }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_PSTACK: "1" },
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	const tab = await page.evaluate(() =>
		window.omp.tabs.list().then(tabs => tabs.find(item => item.active)?.tabId ?? ""),
	);
	return { app, page, tab, record, root };
}

/** Every omp this run spawned: the argv of each `launch` record. */
async function spawnArgv(record: string): Promise<string[]> {
	const launches = await recordsOfType(record, "launch");
	return launches.flatMap(frame => z.array(z.string()).parse(frame.argv));
}

/** The pstack section text the tab's omp would send, or undefined (the inspector's prompt entry and its text). */
async function sectionOf(page: Page, tab: string): Promise<string | undefined> {
	const inspected = await command(page, tab, { type: "get_context_inspect", entries: true });
	expect(inspected.success, JSON.stringify(inspected)).toBe(true);
	const { entries } = Inspected.parse(inspected.data);
	const row = entries.find(entry => entry.label === "<pstack>");
	if (!row) return undefined;
	const entry = await command(page, tab, { type: "get_context_entry", entryId: row.id });
	return EntryText.parse(entry.data).text;
}

async function skillsOf(page: Page, tab: string): Promise<z.infer<typeof Skills>["skills"]> {
	const response = await command(page, tab, { type: "get_skills" });
	expect(response.success, JSON.stringify(response)).toBe(true);
	return Skills.parse(response.data).skills;
}

test("on by default: the pack loads, its skills are listed, a Code session's main agent has the section", async () => {
	test.setTimeout(120_000);
	const { app, page, tab, record } = await launch({});
	try {
		const argv = await spawnArgv(record);
		expect(argv.some(arg => arg.endsWith(path.join("omp-builtin", "pstack")))).toBe(true);

		const skills = await skillsOf(page, tab);
		const names = skills.map(skill => skill.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"poteto-mode",
				"pstack-adapter",
				"pstack-tdd",
				"pstack-teach",
				"principle-fix-root-causes",
			]),
		);
		expect(names).not.toContain("tdd");
		expect(names).not.toContain("teach");
		expect(names).not.toContain("setup-pstack");
		// Hidden from the model's skill list (the section names them), still readable by skill://.
		expect(skills.find(skill => skill.name === "poteto-mode")?.hidden).toBe(true);

		const section = await sectionOf(page, tab);
		expect(section).toContain("<pstack>");
		expect(section).toContain("## Routing gate");
		expect(section).toContain("skill://poteto-mode/playbooks/bug-fix.md");
		expect(section).not.toContain("<pstack-autopilot>");
	} finally {
		await exitApp(app);
	}
});

test("Plan mode leaves the section out and it returns with the mode; Solo delegation flips the delegation paragraph", async () => {
	test.setTimeout(120_000);
	const { app, page, tab } = await launch({});
	try {
		const full = await sectionOf(page, tab);
		expect(full).toContain('`agent: "pstack-agent"`');
		expect((await command(page, tab, { type: "set_plan_mode", enabled: true })).success).toBe(true);
		expect(await sectionOf(page, tab)).toBeUndefined();
		expect((await command(page, tab, { type: "set_plan_mode", enabled: false })).success).toBe(true);
		expect(await sectionOf(page, tab)).toBe(full);

		expect((await command(page, tab, { type: "set_delegation", mode: "solo" })).success).toBe(true);
		const solo = await sectionOf(page, tab);
		expect(solo).toContain("there is no `task` tool");
		expect(solo).not.toBe(full);
		expect((await command(page, tab, { type: "set_delegation", mode: "default" })).success).toBe(true);
		expect(await sectionOf(page, tab)).toBe(full);
	} finally {
		await exitApp(app);
	}
});

test("the switch off: no pack root, no pstack skills, no section", async () => {
	test.setTimeout(120_000);
	const { app, page, tab, record } = await launch({ pstack: false });
	try {
		const argv = await spawnArgv(record);
		expect(argv.some(arg => arg.endsWith(path.join("omp-builtin", "pstack")))).toBe(false);
		const names = (await skillsOf(page, tab)).map(skill => skill.name);
		expect(
			names.filter(name => name.startsWith("principle-") || name.startsWith("pstack-") || name === "poteto-mode"),
		).toEqual([]);
		expect(await sectionOf(page, tab)).toBeUndefined();
	} finally {
		await exitApp(app);
	}
});

test("an Autopilot run gets the condensed section, never the full one", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({ script: { cycleMs: 60_000 }, env: { OMP_GUI_TEST_PSTACK: "1" } });
	const { app, page } = await launchAp(profile);
	try {
		const main = await mainTab(page);
		const before = await sectionOf(page, main);
		expect(before).toContain("<pstack>");
		const run = await startRun(page, main);
		await waitForStatus(page, run, status => status.active === true, "the run is active");
		const section = await sectionOf(page, run);
		expect(section).toContain("<pstack-autopilot>");
		expect(section).toContain("HARD LIMITS outrank");
		expect(section).not.toContain("## Routing gate");
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("the ECC pack: loaded by default with only its index listed, off by its own switch whatever pstack says", async () => {
	test.setTimeout(120_000);
	const eccRoot = path.join("omp-builtin", "ecc");
	const on = await launch({ pstack: false });
	try {
		expect((await spawnArgv(on.record)).some(arg => arg.endsWith(eccRoot))).toBe(true);
		const skills = await skillsOf(on.page, on.tab);
		expect(skills.find(skill => skill.name === "ecc")?.hidden).toBe(false);
		expect(skills.find(skill => skill.name === "golang-patterns")?.hidden).toBe(true);
		expect(skills.map(skill => skill.name)).not.toContain("tdd-workflow");
	} finally {
		await exitApp(on.app);
	}
	const off = await launch({ ecc: false });
	try {
		expect((await spawnArgv(off.record)).some(arg => arg.endsWith(eccRoot))).toBe(false);
		const names = (await skillsOf(off.page, off.tab)).map(skill => skill.name);
		expect(names).toContain("poteto-mode");
		expect(names.filter(name => name === "ecc" || name === "golang-patterns")).toEqual([]);
	} finally {
		await exitApp(off.app);
	}
});
