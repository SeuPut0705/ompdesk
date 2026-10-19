/**
 * The rig the Memory e2e specs share (`ai-memory.e2e.ts`, `memory-page.e2e.ts`): a private HOME, agent dir and desktop
 * profile, the fake binary (`fake-ai-memory.ts`) as `OMP_GUI_AI_MEMORY_BIN`, and another agent's wiring planted first.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import type { AiMemoryPhase } from "../../src/shared/ai-memory";
import { launchApp } from "../harness";
import { type FixtureAiMemory, fixtureAiMemory } from "./fake-ai-memory-install";

/** What a Claude Code settings.json wired by ai-memory looks like; another agent's, never OMPdesk's. */
export const CLAUDE_SETTINGS =
	'{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"ai-memory hook"}]}]}}\n';

export interface Rig {
	root: string;
	home: string;
	desktop: string;
	agent: string;
	project: string;
	record: string;
	memory: FixtureAiMemory;
	/** OMPdesk's own extension root, `<userData>/ai-memory/omp-ext`. */
	extRoot: string;
	/** Another agent's ai-memory wiring, planted before the first launch. */
	claude: string;
}

export interface Launched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

export async function makeRig(): Promise<Rig> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ai-memory-")));
	const rig: Rig = {
		root,
		home: path.join(root, "home"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
		project: path.join(root, "project"),
		record: path.join(root, "rpc.jsonl"),
		memory: await fixtureAiMemory(root),
		extRoot: "",
		claude: "",
	};
	rig.extRoot = path.join(rig.desktop, "ai-memory", "omp-ext");
	rig.claude = path.join(rig.home, ".claude", "settings.json");
	await Promise.all([rig.home, rig.desktop, rig.agent, rig.project].map(dir => fs.mkdir(dir)));
	await fs.mkdir(path.dirname(rig.claude), { recursive: true });
	await fs.writeFile(rig.claude, CLAUDE_SETTINGS);
	await fs.writeFile(
		path.join(rig.desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", themeName: "light" }),
	);
	return rig;
}

export async function launch(rig: Rig, extraEnv: Record<string, string> = {}): Promise<Launched> {
	const app = await launchApp({
		project: rig.project,
		desktop: rig.desktop,
		agent: rig.agent,
		profile: rig.root,
		env: {
			...rig.memory.env,
			HOME: rig.home,
			USERPROFILE: rig.home,
			PI_CONFIG_DIR: "omp-config",
			AI_MEMORY_DATA_DIR: undefined,
			OMP_GUI_TEST_RECORD: rig.record,
			// The fake's "service" is its pid file: that is the unit the app may stop.
			OMP_GUI_AI_MEMORY_UNIT_PIDFILE: path.join(rig.home, ".fake-ai-memory", "server.pid"),
			...extraEnv,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, errors };
}

export const state = (page: Page) => page.evaluate(() => window.omp.aiMemory.getState());

/** Wait for a phase; a miss reports the whole state (its `detail` says why wiring failed). */
export async function phaseIs(page: Page, phase: AiMemoryPhase): Promise<void> {
	try {
		await expect.poll(async () => (await state(page)).phase, { timeout: 60_000 }).toBe(phase);
	} catch (error) {
		throw new Error(`ai-memory never reached ${phase}: ${JSON.stringify(await state(page))}`, { cause: error });
	}
}
