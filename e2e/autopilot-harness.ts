/**
 * Shared pieces of the Autopilot e2e suites (`autopilot-*.e2e.ts`) on the fake omp (`fixture/autopilot.ts`): a profile
 * with a temp git repository and a local bare remote, a launch that wires the fake's session files and recorder, and
 * small readers for the run's status, the git state and what the fake agent did.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { AutopilotStatus } from "../resources/gui-bridge/modes/autopilot-contracts";
import { launchApp, readRecords } from "./harness";

export type Language = "en" | "ko";
export type Theme = "light" | "dark";

export interface ApProfile {
	root: string;
	/** The temp git repository the app opens (branch `main`). */
	project: string;
	/** A local bare remote, `origin` of the project. */
	remote: string;
	desktop: string;
	agent: string;
	/** `OMP_GUI_TEST_RECORD`: every command and bridge request the fake omps got, and what its agents did. */
	record: string;
	env: Record<string, string | undefined>;
	/** `OMP_GUI_TEST_AUTOPILOT` of this profile. */
	script: object;
}

export interface ApProfileOptions {
	language?: Language;
	theme?: Theme;
	/** `OMP_GUI_TEST_AUTOPILOT` (see `fixture/autopilot.ts`). */
	script?: object;
	/** Extra environment of the app (and so of every fake omp). */
	env?: Record<string, string | undefined>;
	/** The repository's AGENTS.md has a release procedure ("## Release"). */
	releaseProcedure?: boolean;
	/** Extra prefs. */
	prefs?: Record<string, unknown>;
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

export async function makeApProfile(options: ApProfileOptions = {}): Promise<ApProfile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-autopilot-")));
	const project = path.join(root, "project");
	const remote = path.join(root, "remote.git");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, remote, desktop, agent].map(dir => fs.mkdir(dir)));
	git(remote, "init", "-q", "--bare", "-b", "main");
	git(project, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(project, "index.ts"), "export const answer = 41;\n// TODO: make it 42\n");
	await fs.writeFile(path.join(project, ".gitignore"), "node_modules\n");
	await fs.writeFile(
		path.join(project, "AGENTS.md"),
		options.releaseProcedure
			? "# Project rules\n\n## Change workflow\n\nTests first, then a release.\n\n## Release\n\nRun scripts/gate.sh, bump the version, push HEAD:main.\n"
			: "# Project rules\n\nKeep changes small.\n",
	);
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "seed");
	git(project, "remote", "add", "origin", remote);
	git(project, "push", "-q", "origin", "main");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: options.language ?? "en",
			themeName: options.theme ?? "light",
			firstRunComplete: true,
			lastProject: project,
			batchNotifications: false,
			...(options.prefs ?? {}),
		}),
	);
	const script = options.script ?? {};
	const record = path.join(root, "rpc.jsonl");
	return {
		root,
		project,
		remote,
		desktop,
		agent,
		record,
		script,
		env: {
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_AUTOPILOT: JSON.stringify(script),
			OMP_WORKTREE_DIR: path.join(root, "wt"),
			GIT_AUTHOR_NAME: "Seed",
			GIT_AUTHOR_EMAIL: "seed@example.invalid",
			GIT_COMMITTER_NAME: "Seed",
			GIT_COMMITTER_EMAIL: "seed@example.invalid",
			...(options.env ?? {}),
		},
	};
}

/** Launch on the profile's userData; resolves once the first sidecar is ready. */
export async function launchAp(profile: ApProfile): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await launchApp({
		project: profile.project,
		desktop: profile.desktop,
		agent: profile.agent,
		profile: profile.root,
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

export async function cleanupAp(profile: ApProfile): Promise<void> {
	await fs.copyFile(profile.record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** TurnResume's launch markers in a userData directory (`interrupted-turns.json`); none when the file is absent. */
export async function markers(desktop: string): Promise<Array<{ reason: string }>> {
	try {
		return JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8"));
	} catch {
		return [];
	}
}

/** The saved layout names the tabs' session files: what a relaunch reopens. */
export async function layoutSessions(desktop: string): Promise<number> {
	try {
		const prefs = JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8")) as {
			tabLayouts?: Array<{ tabs: Array<{ sessionPath?: string }> }>;
		};
		return prefs.tabLayouts?.flatMap(layout => layout.tabs).filter(tab => tab.sessionPath !== undefined).length ?? 0;
	} catch {
		return 0;
	}
}

/** SIGKILL of the app's main process: no quit hook, no teardown. */
export async function crash(app: ElectronApplication): Promise<void> {
	const pid = await app.evaluate(() => process.pid);
	process.kill(pid, "SIGKILL");
	await expect
		.poll(
			() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 20_000, message: "the killed app must be gone" },
		)
		.toBe(false);
}

/** Processes whose command line names `root`: what a killed app left running there. */
export function survivors(root: string): string[] {
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter(line => line.includes(root));
}

/** The run's tab: a tab bound to a worktree on an `autopilot/` branch. */
export interface RunTab {
	tabId: string;
	cwd: string;
	branch: string;
}

export async function runTab(page: Page): Promise<RunTab | null> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	const tab = tabs.find(
		entry => entry.worktree?.branch.startsWith("autopilot/") && !entry.worktree.branch.includes("-c"),
	);
	return tab?.worktree ? { tabId: tab.tabId, cwd: tab.cwd, branch: tab.worktree.branch } : null;
}

export async function tabIds(page: Page): Promise<string[]> {
	return (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId);
}

export async function command(page: Page, tabId: string, body: Record<string, unknown>) {
	return page.evaluate(([id, cmd]) => window.omp.rpc.commandForTab(id as string, cmd as never), [
		tabId,
		body,
	] as const) as Promise<{ success: boolean; data?: unknown; error?: string; code?: string }>;
}

/** `set_autopilot` for a tab; resolves with the response (start answers `{...status, tabId}`). */
export async function setAutopilot(page: Page, tabId: string, action: Record<string, unknown>) {
	return command(page, tabId, { type: "set_autopilot", ...action });
}

export async function mainTab(page: Page): Promise<string> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	return tabs.find(tab => tab.active)?.tabId ?? tabs[0]?.tabId ?? "";
}

/** Start a run from `tabId` through the command (the sheet's own `Start`), returning the new tab. */
export async function startRun(page: Page, tabId: string, options: Record<string, unknown> = {}): Promise<string> {
	const response = await setAutopilot(page, tabId, { action: "start", ...options });
	expect(response, JSON.stringify(response)).toMatchObject({ success: true });
	const started = (response.data as { tabId?: string }).tabId ?? "";
	expect(started).not.toBe("");
	return started;
}

export async function status(page: Page, tabId: string): Promise<AutopilotStatus> {
	const response = await command(page, tabId, { type: "get_autopilot" });
	return (response.data ?? { active: false }) as AutopilotStatus;
}

/** The tab's active tools as its omp lists them (`get_state.dumpTools`), sorted. */
export async function activeTools(page: Page, tabId: string): Promise<string[]> {
	const { data } = await command(page, tabId, { type: "get_state" });
	const dump = data !== null && typeof data === "object" && "dumpTools" in data ? data.dumpTools : undefined;
	return (Array.isArray(dump) ? dump : [])
		.flatMap(tool =>
			tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
				? [tool.name]
				: [],
		)
		.sort();
}

/** An armed parent run's tool set: `autopilot` on, `ask`/`eval`/`debug` off (the bridge's `applyTools`). */
export function expectArmedTools(tools: readonly string[]): void {
	expect(tools).toContain("autopilot");
	for (const name of ["ask", "eval", "debug"]) expect(tools, name).not.toContain(name);
}

/** Poll the run's status until `check` holds; resolves with the status that satisfied it. */
export async function waitForStatus(
	page: Page,
	tabId: string,
	check: (status: AutopilotStatus) => boolean,
	message: string,
	timeout = 60_000,
): Promise<AutopilotStatus> {
	let last: AutopilotStatus = { active: false };
	try {
		await expect
			.poll(
				async () => {
					last = await status(page, tabId);
					return check(last);
				},
				{ message, timeout, intervals: [200, 300, 500] },
			)
			.toBe(true);
	} catch (error) {
		const cycles = last.cycles?.map(cycle => `${cycle.n}:${cycle.verify}`).join(",");
		throw new Error(
			`${message}: state=${last.state} reason=${last.reason ?? "-"} cycle=${last.cycle} now=${last.now?.n ?? "-"} cycles=[${cycles}] inFlight=${last.ship?.inFlight?.kind ?? "-"}\n${String(error)}`,
		);
	}
	return last;
}

/** What the fake omps recorded, of one record type (every tab, in order). */
export async function recorded(profile: ApProfile, type: string): Promise<Record<string, unknown>[]> {
	return (await readRecords(profile.record)).filter(entry => entry.type === type);
}

/** The agent's tool calls of the fake (`fixture_autopilot_tool`). */
export async function agentTools(profile: ApProfile): Promise<Record<string, unknown>[]> {
	return recorded(profile, "fixture_autopilot_tool");
}

/** Commits on `ref` of `repo` not on `main` (subject lines). */
export function commitsAhead(repo: string, ref: string, base = "main"): string[] {
	const out = git(repo, "log", "--format=%s", `${base}..${ref}`);
	return out ? out.split("\n") : [];
}

export function refs(repo: string, pattern: string): string {
	return git(repo, "for-each-ref", "--format=%(refname) %(objectname)", pattern);
}

/** A fake `gh` earlier on PATH: `run view` answers `conclusion`, `pr create` fails (a local remote is no GitHub repository). */
export async function installFakeGh(profile: ApProfile, conclusion: "success" | "failure"): Promise<void> {
	const bin = path.join(profile.root, "bin");
	await fs.mkdir(bin, { recursive: true });
	await fs.writeFile(
		path.join(bin, "gh"),
		`#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "view" ]; then echo '{"status":"completed","conclusion":"${conclusion}"}'; exit 0; fi\nif [ "$1" = "auth" ]; then exit 0; fi\nexit 1\n`,
		{ mode: 0o755 },
	);
	profile.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

/** A passing and a failing release gate script in the repository (the fake agent runs it as the procedure's first step). */
export async function writeGate(profile: ApProfile, exitCode: 0 | 1): Promise<void> {
	await fs.mkdir(path.join(profile.project, "scripts"), { recursive: true });
	await fs.writeFile(path.join(profile.project, "scripts", "gate.sh"), `#!/bin/sh\nexit ${exitCode}\n`, {
		mode: 0o755,
	});
	git(profile.project, "add", "scripts/gate.sh");
	git(profile.project, "commit", "-q", "-m", "gate");
	git(profile.project, "push", "-q", "origin", "main");
}

/** Every later `git push` from the repository (the run's worktree shares its hooks) takes at least `seconds`. */
export async function slowPushes(profile: ApProfile, seconds: number): Promise<void> {
	const hooks = path.resolve(profile.project, git(profile.project, "rev-parse", "--git-path", "hooks"));
	await fs.mkdir(hooks, { recursive: true });
	await fs.writeFile(path.join(hooks, "pre-push"), `#!/bin/sh\nsleep ${seconds}\n`, { mode: 0o755 });
}

/** Poll until the run's tab exists (the start made its worktree and opened it). */
export async function waitForRunTab(page: Page): Promise<RunTab> {
	let found: RunTab | null = null;
	await expect
		.poll(
			async () => {
				found = await runTab(page);
				return found !== null;
			},
			{ timeout: 60_000, message: "the run's tab opens" },
		)
		.toBe(true);
	return found as unknown as RunTab;
}

/** The status once the cycle count has stood still for two seconds (a turn admitted before a pause arrived has finished). */
export async function settledStatus(page: Page, tabId: string): Promise<AutopilotStatus> {
	let last = await status(page, tabId);
	for (let stable = 0; stable < 4; ) {
		await page.waitForTimeout(500);
		const next = await status(page, tabId);
		stable = next.cycles?.length === last.cycles?.length && next.now === undefined ? stable + 1 : 0;
		last = next;
	}
	return last;
}

const AUTOPILOT_TAB: Record<Language, RegExp> = { en: /^Autopilot/, ko: /^오토파일럿/ };

/** Start a run the way a user does: Mode popover > Autopilot > Start. The run's tab opens focused; resolves with it. */
export async function startFromSheet(page: Page, language: Language): Promise<RunTab> {
	await page.locator("[data-composer-modes-trigger]").click();
	await page.getByRole("tab", { name: AUTOPILOT_TAB[language] }).click();
	await page.locator("[data-autopilot-start]").click();
	return waitForRunTab(page);
}
