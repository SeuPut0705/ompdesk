/**
 * A project's one Delete (the owner's report, 8 Nov 2026: "삭제 누르면 지워져야 하는데 사이드바에서 제거를 해야 지워짐"),
 * on the built app: this computer's project and a paired host's project from the paired computer. Without the confirm's
 * box the project leaves the list of the computer it belongs to and every saved session stays; with it the saved
 * sessions are deleted too. `OMP_GUI_PROJECT_DELETE=<dir>` writes captures.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { captureTo, cssString, exitApp, fixtureOmp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_PROJECT_DELETE;

/** A stored session in the fake omp's journal format (title slot, header, one exchange); no tab holds it. */
async function seedSession(agent: string, id: string, cwd: string, title: string): Promise<string> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date().toISOString();
	const lines = [
		{ type: "title", v: 1, title, updatedAt: at },
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{ type: "message", id: `${id}-1`, parentId: null, timestamp: at, message: { role: "user", content: title } },
		{
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text: `${title} answer` }] },
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	);

/** The project's header menu → Delete, then the confirm, with the opt-in box ticked or left as it opens. */
async function deleteProject(page: Page, header: Locator, alsoSessions: boolean): Promise<void> {
	await header.click({ button: "right" });
	const items = page.getByRole("menuitem");
	await expect(items.last()).toHaveText("Delete");
	await expect(page.getByRole("menuitem", { name: "Remove from sidebar" })).toHaveCount(0);
	await items.last().click();
	const dialog = page.getByRole("dialog");
	const box = dialog.getByRole("checkbox");
	await expect(box).not.toBeChecked();
	if (alsoSessions) await box.check();
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toHaveCount(0);
}

test("Delete takes this computer's project off the list, and its sessions with it only when the box is ticked", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-delete-")));
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const [keep, alpha, beta] = ["keep", "alpha", "beta"].map(name => path.join(root, name));
	await Promise.all([desktop, agent, keep, alpha, beta].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: keep }),
	);
	const alphaFiles = [
		await seedSession(agent, "01b22000-0000-7000-8000-0000000000a1", alpha, "Alpha one"),
		await seedSession(agent, "01b22000-0000-7000-8000-0000000000a2", alpha, "Alpha two"),
	];
	const betaFiles = [
		await seedSession(agent, "01b22000-0000-7000-8000-0000000000b1", beta, "Beta one"),
		await seedSession(agent, "01b22000-0000-7000-8000-0000000000b2", beta, "Beta two"),
	];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let app: ElectronApplication | null = null;
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await page.setViewportSize({ width: 1180, height: 820 });
		const group = (cwd: string) => page.locator(`.omp-session-sidebar [data-workspace-group=${cssString(cwd)}]`);
		for (const cwd of [alpha, beta]) await expect(group(cwd)).toBeVisible({ timeout: 60_000 });
		const listed = () => page.evaluate(() => window.omp.sidebarProjects.command({ action: "get" }));
		await captureTo(CAPTURES, page, "local-1-before");

		// Box off: the project leaves the list; both saved sessions stay on disk and in the session list.
		await deleteProject(page, group(alpha), false);
		await expect(group(alpha)).toHaveCount(0, { timeout: 5_000 });
		await captureTo(CAPTURES, page, "local-2-removed-sessions-kept");
		const state = await listed();
		expect(state.projects.map(project => project.path)).not.toContain(alpha);
		expect(state.removed).toContain(alpha);
		for (const file of alphaFiles) expect(await exists(file), file).toBe(true);
		const all = await page.evaluate(() => window.omp.sessions.list("global"));
		for (const file of alphaFiles) expect(all.map(session => session.path)).toContain(file);

		// Box ticked: the sessions are deleted first, then the project leaves the list.
		await deleteProject(page, group(beta), true);
		await expect(group(beta)).toHaveCount(0, { timeout: 15_000 });
		await captureTo(CAPTURES, page, "local-3-deleted-with-sessions");
		for (const file of betaFiles) await expect.poll(() => exists(file), { message: file }).toBe(false);
		expect((await listed()).removed).toContain(beta);
		expect((await listed()).projects.map(project => project.path)).not.toContain(beta);
		// The other project's sessions were never touched.
		for (const file of alphaFiles) expect(await exists(file), file).toBe(true);
	} finally {
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Delete on a paired host's project edits the host's own list, and deletes its sessions on the host only with the box", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-delete-remote-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		const agent = path.join(hostProfile.root, "agent");
		const [kept, gone] = [path.join(hostProfile.root, "kept"), path.join(hostProfile.root, "gone")];
		await Promise.all([fs.mkdir(kept), fs.mkdir(gone)]);
		const keptFiles = [
			await seedSession(agent, "01b22000-0000-7000-8000-0000000000d1", kept, "Kept one"),
			await seedSession(agent, "01b22000-0000-7000-8000-0000000000d2", kept, "Kept two"),
		];
		const goneFiles = [
			await seedSession(agent, "01b22000-0000-7000-8000-0000000000e1", gone, "Gone one"),
			await seedSession(agent, "01b22000-0000-7000-8000-0000000000e2", gone, "Gone two"),
		];
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");

		const onDevice = (cwd: string) =>
			a.locator(`[data-sidebar-device="${deviceId}"] [data-device-group=${cssString(cwd)}]`);
		const onHost = (cwd: string) => b.locator(`.omp-session-sidebar [data-workspace-group=${cssString(cwd)}]`);
		const hostList = () => b.evaluate(() => window.omp.sidebarProjects.command({ action: "get" }));
		for (const cwd of [kept, gone]) {
			await expect(onDevice(cwd), `A lists ${cwd}`).toHaveCount(1, { timeout: 60_000 });
			await expect(onHost(cwd), `B lists ${cwd}`).toHaveCount(1, { timeout: 60_000 });
		}
		await captureTo(CAPTURES, a, "host-1-before-paired");
		await captureTo(CAPTURES, b, "host-1-before-host");

		// Box off, from the paired computer: the project leaves the host's own list and both windows; the sessions stay.
		await deleteProject(a, onDevice(kept).locator(".group\\/head"), false);
		await expect(onDevice(kept)).toHaveCount(0, { timeout: 5_000 });
		await expect(onHost(kept)).toHaveCount(0, { timeout: 10_000 });
		await captureTo(CAPTURES, a, "host-2-removed-paired");
		await captureTo(CAPTURES, b, "host-2-removed-host");
		const afterKept = await hostList();
		expect(afterKept.removed).toContain(kept);
		expect(afterKept.projects.map(project => project.path)).not.toContain(kept);
		for (const file of keptFiles) expect(await exists(file), file).toBe(true);

		// Box ticked: the host's saved sessions are deleted on the host, then its project leaves its list.
		await deleteProject(a, onDevice(gone).locator(".group\\/head"), true);
		await expect(onDevice(gone)).toHaveCount(0, { timeout: 15_000 });
		await expect(onHost(gone)).toHaveCount(0, { timeout: 15_000 });
		await captureTo(CAPTURES, a, "host-3-deleted-paired");
		await captureTo(CAPTURES, b, "host-3-deleted-host");
		for (const file of goneFiles) await expect.poll(() => exists(file), { message: file }).toBe(false);
		const afterGone = await hostList();
		expect(afterGone.removed).toContain(gone);
		for (const file of keptFiles) expect(await exists(file), file).toBe(true);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
