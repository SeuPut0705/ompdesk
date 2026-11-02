import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import {
	appLaunchOptions,
	capture,
	controlToolCaller,
	cssString,
	exitApp,
	openedSessions,
	recordsOfType,
} from "./harness";
import { survivors } from "./process-tree";

declare global {
	interface Window {
		/** Every distinct state of the tabs' memory waits a relaunch's window saw: JSON of [tabId, position] pairs. */
		__memoryStates?: string[];
	}
}

// A relaunch after a crash continues agent-opened sessions' interrupted turns only as this computer's memory allows
// (src/main/memory-admission.ts, `TurnResume #run` → `ResumeDeps.admit`). Here: five agent-opened sessions cut off
// mid-turn, the app killed (SIGKILL, no quit hook) and launched again on the same profile with 3 GB free of 16. Nothing
// continues; the five wait in line (1..5, the tab list's `memoryWait` every view reads); raising memory starts them in
// line order, the first ones before the rest; all five finish the cut-off turn in their own session file.
//
// Not covered here, on purpose: a relaunch that also finds the network unreachable (the connection wait comes first,
// then memory). The fake omp cannot make a launch read offline: `net.isOnline()` is the machine's own and
// OMP_GUI_TEST_UNREACHABLE only fails the probe a *failed turn* triggers, after the continuation already started.
// That order is unit-tested in src/main/turn-resume.test.ts ("a relaunch's continuations of agent work wait for
// memory": `admit` is asked after the connection hold; "a continuation held for the connection": the relaunch's own
// wait is held with nothing sent until a probe answers).

interface Profile {
	root: string;
	project: string;
	desktop: string;
	agent: string;
	record: string;
	memory: string;
}

const setMemory = (profile: Profile, totalGb: number, availableGb: number) =>
	fs.writeFile(profile.memory, JSON.stringify({ totalGb, availableGb, pressure: "normal" }));

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-memory-relaunch-")));
	const profile: Profile = {
		root,
		project: path.join(root, "project"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
		record: path.join(root, "rpc.jsonl"),
		memory: path.join(root, "memory.json"),
	};
	await Promise.all([fs.mkdir(profile.project), fs.mkdir(profile.desktop), fs.mkdir(profile.agent)]);
	await fs.writeFile(
		path.join(profile.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, lastProject: profile.project }),
	);
	return profile;
}

/** The first launch opens the project; a relaunch has no argv folder, so it restores the saved layout. */
async function launch(profile: Profile, relaunch: boolean): Promise<{ app: ElectronApplication; page: Page }> {
	const { args, env } = await appLaunchOptions({
		project: profile.project,
		desktop: profile.desktop,
		agent: profile.agent,
		profile: profile.root,
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: profile.record,
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_MEMORY: profile.memory,
			OMP_GUI_TEST_MEMORY_MS: "100",
		},
	});
	const app = await electron.launch({ args: relaunch ? args.filter(arg => arg !== profile.project) : args, env });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

const tabsOf = (page: Page) => page.evaluate(() => window.omp.tabs.list());

async function markers(profile: Profile): Promise<Array<{ reason: string; sessionPath: string; agent?: boolean }>> {
	try {
		return JSON.parse(await fs.readFile(path.join(profile.desktop, "interrupted-turns.json"), "utf8"));
	} catch {
		return [];
	}
}

/** The saved layout names every session file: what a relaunch reopens. */
async function layoutSessions(profile: Profile): Promise<string[]> {
	try {
		const prefs = JSON.parse(await fs.readFile(path.join(profile.desktop, "prefs.json"), "utf8")) as {
			tabLayouts?: Array<{ tabs: Array<{ sessionPath?: string }> }>;
		};
		return (prefs.tabLayouts ?? []).flatMap(layout => layout.tabs.flatMap(tab => tab.sessionPath ?? []));
	} catch {
		return [];
	}
}

async function runtimeLog(
	profile: Profile,
): Promise<Array<{ source?: string; message?: string; details?: Record<string, unknown> }>> {
	const text = await fs.readFile(path.join(profile.desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { source?: string; message?: string; details?: Record<string, unknown> });
}

/** SIGKILL of the app's own main process, then until it and its children are gone (a relaunch needs the profile lock). */
async function crash(app: ElectronApplication, profile: Profile): Promise<void> {
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
	await expect
		.poll(() => survivors(profile.root), { timeout: 20_000, message: "the killed app's children must end" })
		.toEqual([]);
}

test("a relaunch holds five agent sessions' cut-off turns for memory in line order and continues them as memory frees", async () => {
	test.setTimeout(240_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		// First launch, memory ample (64 GB): five agent-opened sessions, each in a turn that keeps running.
		await setMemory(profile, 64, 60);
		const first = await launch(profile, false);
		current = first.app;
		await expect
			.poll(async () => (await first.page.evaluate(() => window.omp.sidecar.getStatus())).status, {
				timeout: 60_000,
			})
			.toBe("ready");
		const call = await controlToolCaller(first.page, profile.record);
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const open = await call("ompdesk_session_open", { folder: profile.project });
			expect(open.isError, open.text).toBe(false);
			ids.push(...openedSessions(open.text));
		}
		expect(ids).toHaveLength(5);
		for (const id of ids)
			await expect
				.poll(async () => (await tabsOf(first.page)).find(tab => tab.tabId === id)?.status, { timeout: 60_000 })
				.toBe("ready");
		// The person's own prompt starts each turn (never held); the sessions stay agent-opened (`openedBy`), so the
		// marker records them as agent work.
		for (const id of ids) {
			const sent = await first.page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture running with job" }),
				id,
			);
			expect(sent).toMatchObject({ success: true });
		}
		await expect
			.poll(async () => (await tabsOf(first.page)).filter(tab => ids.includes(tab.tabId)).map(tab => tab.status), {
				timeout: 60_000,
			})
			.toEqual(Array(5).fill("running"));
		await expect
			.poll(async () => (await markers(profile)).filter(marker => marker.reason === "running"), { timeout: 30_000 })
			.toHaveLength(5);
		expect((await markers(profile)).every(marker => marker.agent === true)).toBe(true);
		await expect
			.poll(async () => (await layoutSessions(profile)).length, { timeout: 30_000 })
			.toBeGreaterThanOrEqual(5);
		const interrupted = (await markers(profile)).map(marker => marker.sessionPath);
		await crash(first.app, profile);
		current = undefined;

		// Relaunch on the same profile with 3 GB free of 16: below one expected session above the 2.4 GB kept free.
		await setMemory(profile, 16, 3);
		const before = (await recordsOfType(profile.record, "restore_interrupted")).length;
		const second = await launch(profile, true);
		current = second.app;
		const page = second.page;
		const waiting = async () =>
			(await tabsOf(page))
				.filter(tab => tab.memoryWait !== undefined)
				.map(tab => ({ tabId: tab.tabId, position: tab.memoryWait?.position ?? 0, sessionPath: tab.sessionPath }));
		await expect
			.poll(async () => (await waiting()).map(entry => entry.position).sort(), { timeout: 60_000 })
			.toEqual([1, 2, 3, 4, 5]);
		const line = (await waiting()).sort((a, b) => a.position - b.position);
		expect(line.map(entry => entry.sessionPath).sort()).toEqual([...interrupted].sort());

		// Held means held: no omp started a continuation, the markers still stand, the log says so once per session.
		await page.waitForTimeout(1_500);
		expect((await recordsOfType(profile.record, "restore_interrupted")).length).toBe(before);
		expect((await markers(profile)).filter(marker => marker.reason === "running")).toHaveLength(5);
		const held = (await runtimeLog(profile)).filter(
			entry => entry.source === "memory" && entry.message === "memory hold",
		);
		expect(held.filter(entry => entry.details?.kind === "resume")).toHaveLength(5);
		// The wait is shown where a person looks: the sidebar's label on all five rows, and the row in the pane of the
		// session first in line (opened by its sidebar row).
		const rows = page.locator(".omp-sidebar-session-row[data-session-path]");
		await expect(rows.filter({ hasText: "Waiting for memory" })).toHaveCount(5);
		const [head] = line;
		await rows.and(page.locator(`[data-session-path=${cssString(head?.sessionPath ?? "")}]`)).click();
		await expect(page.locator("[data-memory-wait]")).toContainText(
			"Waiting for memory: 3 GB free of 16 GB · #1 in line · starts by itself",
		);
		await capture(page, "relaunch-waiting");

		// Memory frees, but only for two: the first two in line continue, the other three keep waiting (7.5 GB free:
		// the second start leaves 2.5 GB above the 2.4 GB kept, a third would not).
		// A page-side recorder sees every state in between, whatever the app's pace: each tab's wait, every 25 ms.
		await page.evaluate(() => {
			const states: string[] = [];
			window.__memoryStates = states;
			const tick = async () => {
				const tabs = await window.omp.tabs.list();
				const state = JSON.stringify(
					tabs.filter(tab => tab.memoryWait).map(tab => [tab.tabId, tab.memoryWait?.position]),
				);
				if (states.at(-1) !== state) states.push(state);
			};
			setInterval(() => void tick(), 25);
		});
		await setMemory(profile, 16, 7.5);
		// The line first shrinks (some started), then empties; the recorder holds both.
		await expect.poll(async () => (await waiting()).length, { timeout: 60_000 }).toBeLessThan(5);
		// Every continuation answers in its own session file, and the markers go.
		for (const sessionPath of interrupted)
			await expect
				.poll(() => fs.readFile(sessionPath, "utf8").catch(() => ""), { timeout: 90_000 })
				.toContain("Continued after the interruption.");
		await expect.poll(async () => (await waiting()).length, { timeout: 30_000 }).toBe(0);
		await expect.poll(() => markers(profile), { timeout: 30_000 }).toEqual([]);

		// Order: the first time each tab left the line is the order it stood in, and a mid state existed in which the
		// first ones had started while the rest still waited.
		const states = ((await page.evaluate(() => window.__memoryStates)) ?? []).map(
			state => JSON.parse(state) as Array<[string, number]>,
		);
		const leftAt = (tabId: string) => states.findIndex(state => !state.some(([id]) => id === tabId));
		const order = line.map(entry => leftAt(entry.tabId));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// 7.5 GB free admits two, so there was a state with the first two started and the last three waiting.
		expect(
			states.map(state => state.length),
			JSON.stringify(states),
		).toContain(3);
		const released = (await runtimeLog(profile)).filter(
			entry => entry.source === "memory" && entry.message === "memory release" && entry.details?.kind === "resume",
		);
		expect(released.map(entry => entry.details?.tab)).toEqual(line.map(entry => entry.tabId));
	} finally {
		if (current) await exitApp(current);
		await expect
			.poll(() => survivors(profile.root), { timeout: 20_000 })
			.toEqual([])
			.catch(() => undefined);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
