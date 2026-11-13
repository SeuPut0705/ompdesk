/**
 * A project only sessions brought in leaves the sidebar with its last session (the owner's report, 13 Nov 2026: the
 * Mac mini kept seuoffice and yuyu-mos after the agent sessions that had brought them in were deleted), on the built
 * app, this computer's own list and a paired host's: deleting the sessions alone takes such a project off, while one
 * the person added and one they pinned stay. `OMP_GUI_PROJECT_AUTO_LEAVE=<dir>` writes captures.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { captureTo, cssString, exitApp, fixtureOmp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_PROJECT_AUTO_LEAVE;

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

/** The three folders each case uses: one only its session brought in, one the person added, one they pinned. */
async function seedThree(agent: string, root: string, idPrefix: string) {
	const [auto, added, pinned] = ["auto", "added", "pinned"].map(name => path.join(root, name));
	await Promise.all([auto, added, pinned].map(dir => fs.mkdir(dir)));
	const files = {
		auto: await seedSession(agent, `${idPrefix}1`, auto, "Auto session"),
		added: await seedSession(agent, `${idPrefix}2`, added, "Added session"),
		pinned: await seedSession(agent, `${idPrefix}3`, pinned, "Pinned session"),
	};
	return { auto, added, pinned, files };
}

const listed = (page: Page, device?: string) =>
	page.evaluate(
		async d => (await window.omp.sidebarProjects.command({ action: "get" }, d)).projects.map(entry => entry.path),
		device,
	);

test("this computer: deleting a project's last session takes it off only when sessions alone brought it in", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-auto-leave-")));
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const keep = path.join(root, "keep");
	await Promise.all([desktop, agent, keep].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: keep }),
	);
	const { auto, added, pinned, files } = await seedThree(agent, root, "01b23000-0000-7000-8000-00000000000");
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
		for (const cwd of [auto, added, pinned]) await expect(group(cwd)).toBeVisible({ timeout: 60_000 });
		// The person adds one folder and pins another; the third only its session brought in.
		await page.evaluate(cwd => window.omp.sidebarProjects.command({ action: "add", path: cwd }), added);
		await page.evaluate(cwd => window.omp.prefs.updateSidebar({ op: "set-group-pinned", cwd, pinned: true }), pinned);
		await captureTo(CAPTURES, page, "local-1-before");

		for (const file of Object.values(files)) await page.evaluate(f => window.omp.sessions.delete(f), file);
		await expect(group(auto)).toHaveCount(0, { timeout: 15_000 });
		await captureTo(CAPTURES, page, "local-2-after");
		await expect(group(added)).toBeVisible();
		await expect(group(pinned)).toBeVisible();
		const after = await listed(page);
		expect(after).not.toContain(auto);
		expect(after).toEqual(expect.arrayContaining([added, pinned]));
		// It left by itself, not by the person's Delete: a session there later brings it back.
		const removed = (await page.evaluate(() => window.omp.sidebarProjects.command({ action: "get" }))).removed;
		expect(removed).not.toContain(auto);
	} finally {
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a paired host: deleting a host project's last session from the device takes it off both sidebars only when sessions alone brought it in", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-auto-leave-remote-")));
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
		const { auto, added, pinned, files } = await seedThree(
			agent,
			hostProfile.root,
			"01b23000-0000-7000-8000-00000000001",
		);
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
		for (const cwd of [auto, added, pinned]) {
			await expect(onDevice(cwd), `A lists ${cwd}`).toHaveCount(1, { timeout: 60_000 });
			await expect(onHost(cwd), `B lists ${cwd}`).toHaveCount(1, { timeout: 60_000 });
		}
		// The device adds one folder to the host's list; the host's person pins another (pins are that computer's).
		await a.evaluate(([cwd, d]) => window.omp.sidebarProjects.command({ action: "add", path: cwd }, d), [
			added,
			deviceId,
		] as const);
		await b.evaluate(cwd => window.omp.prefs.updateSidebar({ op: "set-group-pinned", cwd, pinned: true }), pinned);
		await captureTo(CAPTURES, a, "host-1-before-paired");

		// The device deletes the host's sessions.
		for (const file of Object.values(files))
			await a.evaluate(([f, d]) => window.omp.sessions.delete(f, d), [file, deviceId] as const);
		await expect(onDevice(auto)).toHaveCount(0, { timeout: 15_000 });
		await expect(onHost(auto)).toHaveCount(0, { timeout: 15_000 });
		await captureTo(CAPTURES, a, "host-2-after-paired");
		await captureTo(CAPTURES, b, "host-2-after-host");
		for (const cwd of [added, pinned]) {
			await expect(onDevice(cwd), `A keeps ${cwd}`).toHaveCount(1);
			await expect(onHost(cwd), `B keeps ${cwd}`).toHaveCount(1);
		}
		const hostList = await listed(b);
		expect(hostList).not.toContain(auto);
		expect(hostList).toEqual(expect.arrayContaining([added, pinned]));
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
