/**
 * Deep links against the real shell (PROTOCOL.md §15.3): a refused second launch hands its argv to the first instance,
 * which holds it until Node says its startup windows exist, then reads it (`omp://` URL, a folder, anything else) and
 * asks Node for a window when none shows the folder. The decisions over every URL, path and argv form are
 * `chrome_core::deep_link`'s captured replay; delivery of a link to a loaded page needs a window and belongs to the
 * e2e specs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointChromeAt } from "./chrome";
import { startDeepLinks } from "./chrome-deep-link";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

vi.mock("electron", () => ({ BrowserWindow: { fromId: () => null } }));

const exe = testShellExecutable();

const shells: TestShell[] = [];
const folders: string[] = [];
afterEach(async () => {
	for (const shell of shells.splice(0)) await shell.close().catch(() => undefined);
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A shell with Node's side served: `chrome.spawn` is recorded and answers "no window". */
async function start(): Promise<{ shell: TestShell; spawns: Array<{ cwd?: string | null }> }> {
	if (!exe) throw new Error("no shell");
	const shell = await startTestShell(exe, { env: { OMP_GUI_HEADLESS: "1" } });
	shells.push(shell);
	const spawns: Array<{ cwd?: string | null }> = [];
	shell.client.handle("chrome.spawn", (params: { cwd?: string | null }) => {
		spawns.push(params);
		return { winId: null };
	});
	pointChromeAt(() => shell.client);
	return { shell, spawns };
}

/** A second launch of the same profile: it hands its argv over and exits 0. */
async function secondLaunch(shell: TestShell, ...args: string[]): Promise<void> {
	if (!exe) throw new Error("no shell");
	const child = spawn(exe, [`--user-data-dir=${shell.userData}`, ...args], { stdio: "ignore" });
	const { promise, resolve } = Promise.withResolvers<number | null>();
	child.once("exit", code => resolve(code));
	expect(await promise).toBe(0);
}

function folder(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-links-")));
	folders.push(dir);
	return dir;
}

describe.skipIf(!exe)("deep links", () => {
	it("holds a launch's link until Node's startup windows exist, then asks for the default window", async () => {
		const { shell, spawns } = await start();
		await secondLaunch(shell, "omp://new");
		await secondLaunch(shell, "omp://session/abc");
		expect(spawns).toEqual([]);
		startDeepLinks();
		// Held arrivals replay in order; with no window the first one spawns it and the Node answer says none opened.
		await vi.waitFor(() => expect(spawns).toHaveLength(2));
		expect(spawns.map(spawned => spawned.cwd ?? null)).toEqual([null, null]);
	});

	it("opens a launch's folder in a window of its own, resolved, when none shows it", async () => {
		const { shell, spawns } = await start();
		startDeepLinks();
		const dir = folder();
		await secondLaunch(shell, "--some-switch", `${dir}${path.sep}`);
		await vi.waitFor(() => expect(spawns).toHaveLength(1));
		expect(spawns[0].cwd).toBe(path.resolve(dir));
	});

	it("does nothing for a path that is no folder, a relative folder, or a bare launch with no window", async () => {
		const { shell, spawns } = await start();
		startDeepLinks();
		await secondLaunch(shell, path.join(tmpdir(), "omp-links-missing"));
		await secondLaunch(shell, ".");
		await secondLaunch(shell);
		// Arrivals are handled in order: the one that follows is the first to reach Node.
		const dir = folder();
		await secondLaunch(shell, dir);
		await vi.waitFor(() => expect(spawns).toHaveLength(1));
		expect(spawns[0].cwd).toBe(path.resolve(dir));
	});

	it("takes a link that arrives after the windows exist at once", async () => {
		const { shell, spawns } = await start();
		startDeepLinks();
		await secondLaunch(shell, "omp://session/abc");
		await vi.waitFor(() => expect(spawns).toHaveLength(1));
	});
});
