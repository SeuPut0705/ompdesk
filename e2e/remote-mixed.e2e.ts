import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { appLaunchOptions, exitApp, fixtureOmp, readRecords, walkRemotePicker } from "./harness";
import { freePort, remoteTailscale } from "./remote-harness";

// A computer on an older release and one on this build share over the tailnet, each way round: the older one's
// link is the TypeScript one, this build's runs in the core. `OMP_GUI_E2E_OLD_APP` names the older release's
// checkout, built (`bun run build`, `bun run build:native` in it); without it the spec is skipped.
const OLD = process.env.OMP_GUI_E2E_OLD_APP;

interface Instance {
	app: ElectronApplication;
	page: Page;
	record: string;
	project: string;
}

async function launch(profile: string, name: string, port: number, old: boolean): Promise<Instance> {
	const root = path.join(profile, name);
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await fs.mkdir(root);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const record = path.join(root, "record.jsonl");
	const tailscale = await remoteTailscale(root, name);
	const options = await appLaunchOptions({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_OMP: await fixtureOmp(root),
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_REMOTE_PORT: String(port),
			OMP_GUI_TEST_REMOTE_LOOPBACK: "1",
			OMP_GUI_TEST_LOGIN: "1",
			...tailscale.env,
		},
	});
	const app = await electron.launch(
		old && OLD
			? // The older release's main on this checkout's Electron (the same major across these releases).
				{ ...options, args: [path.join(OLD, "out/main/index.js"), ...options.args.slice(1)] }
			: options,
	);
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.remote != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, record, project: await fs.realpath(project) };
}

for (const [hostOld, label] of [
	[true, "an older host and this build as the device"],
	[false, "this build as the host and an older device"],
] as const) {
	test(`pairs and runs a prompt over the link: ${label}`, async () => {
		test.skip(!OLD, "OMP_GUI_E2E_OLD_APP names no older build");
		test.setTimeout(180_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-mixed-"));
		const port = await freePort();
		let host: Instance | null = null;
		let client: Instance | null = null;
		try {
			host = await launch(profile, "b", port, hostOld);
			client = await launch(profile, "a", port, !hostOld);
			const b = host.page;
			const a = client.page;
			await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
			await b.evaluate(() => window.omp.remote.setHostEnabled(true));
			await expect.poll(async () => (await b.evaluate(() => window.omp.remote.getState())).host.port).toBe(port);

			let nodeId = "";
			await expect
				.poll(
					async () => {
						const computers = await a.evaluate(() => window.omp.remote.watchTailnet(true));
						nodeId = computers.find(computer => computer.state === "available")?.nodeId ?? "";
						return nodeId;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
			const { deviceId } = await a.evaluate(id => window.omp.remote.connect(id), nodeId);
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
				.toBe("online");
			await expect
				.poll(async () => (await b.evaluate(() => window.omp.remote.getState())).host.peers[0]?.online)
				.toBe(true);

			const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
			await expect(section).toHaveAttribute("data-device-state", "online");
			await section.locator(`[data-sidebar-device-toggle="${deviceId}"]`).hover();
			await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
			const picker = a.getByRole("dialog", { name: /Choose a folder on/ });
			await walkRemotePicker(picker, host.project);
			await picker.locator("[data-remote-picker-open]").click();
			await expect
				.poll(
					async () =>
						(await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status,
					{ timeout: 60_000 },
				)
				.toBe("ready");

			// A reply streamed over the link: slim events, deflated against the link's context, sealed both ways.
			await a.locator("textarea").first().fill("mixed hello");
			await a.getByRole("button", { name: "Send", exact: true }).click();
			await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);
			const isPrompt = (frame: Record<string, unknown>) =>
				frame.type === "prompt" && frame.message === "mixed hello";
			await expect.poll(async () => (await readRecords(host?.record ?? "")).some(isPrompt)).toBe(true);

			// The link drops with the host's sharing and comes back with it.
			await b.evaluate(() => window.omp.remote.setHostEnabled(false));
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
				.not.toBe("online");
			await b.evaluate(() => window.omp.remote.setHostEnabled(true));
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");
		} finally {
			if (client) await exitApp(client.app);
			if (host) await exitApp(host.app);
			await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
		}
	});
}
