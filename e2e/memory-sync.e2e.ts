/**
 * Memory shared between two paired computers (src/main/ai-memory/sync.ts) on the built app: two apps on the fake
 * Tailscale, each with its own fake ai-memory server (e2e/fixture/fake-ai-memory.ts). The device connects to the host;
 * a decision written on either side becomes readable on the other, marked with the computer it came from, and is never
 * written back. The rules (hashes, conflicts, durable folders, memory off, a blocked device) are pinned by
 * src/main/ai-memory/sync.test.ts and the host.memory case of src/main/remote/host-services.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { phaseIs } from "./fixture/ai-memory-rig";
import { type FixtureAiMemory, fixtureAiMemory } from "./fixture/fake-ai-memory-install";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const ALPHA = { workspace: "fixture", project: "alpha" };

interface Computer {
	memory: FixtureAiMemory;
	app: RemoteInstance;
}

/** One computer: its own HOME, fake ai-memory server and fake Tailscale; a device takes its host's `port` to probe. */
async function computer(parent: string, name: string, port?: number): Promise<Computer> {
	const home = path.join(parent, `${name}-home`);
	await fs.mkdir(home);
	const memory = await fixtureAiMemory(path.join(parent, `${name}-memory`));
	const profile = await makeRemoteProfile(parent, name, {
		language: "en",
		theme: "light",
		...(port === undefined ? {} : { port }),
		env: {
			...memory.env,
			HOME: home,
			USERPROFILE: home,
			PI_CONFIG_DIR: "omp-config",
			OMP_GUI_AI_MEMORY_UNIT_PIDFILE: path.join(home, ".fake-ai-memory", "server.pid"),
			OMP_GUI_TEST_MEMORY_SYNC_MS: "1000",
		},
	});
	return { memory, app: await launchRemote(profile) };
}

const readBody = (page: Page, file: string) =>
	page.evaluate(
		ref =>
			window.omp.aiMemory
				.readPage(ref)
				.then(found => found.markdown)
				.catch(() => null),
		{ ...ALPHA, path: file },
	);

const writes = async (memory: FixtureAiMemory, file: string) =>
	(await memory.requests()).filter(request => request.path === "/admin/write-page" && request.body?.path === file);

test("a decision made on one computer is in the other's memory, and never comes back", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-sync-")));
	let host: Computer | undefined;
	let device: Computer | undefined;
	try {
		const win = await computer(parent, "win");
		host = win;
		const mac = await computer(parent, "mac", win.app.profile.port);
		device = mac;
		await phaseIs(host.app.page, "ready");
		await phaseIs(device.app.page, "ready");
		const hostId = await connectHost(host.app.page, device.app.page, "win");
		const deviceId = (await host.app.page.evaluate(() => window.omp.remote.getState())).host.peers[0]?.deviceId;
		expect(deviceId).toBeTruthy();

		// Written on the device: the host's memory holds it, marked as the device's.
		await device.app.page.evaluate(
			ref => window.omp.aiMemory.writePage({ ...ref, title: "Sharing", kind: "decision", body: "Tailscale only." }),
			{ ...ALPHA, path: "decisions/sharing.md" },
		);
		await expect
			.poll(() => readBody(win.app.page, "decisions/sharing.md"), { timeout: 30_000 })
			.toBe("Tailscale only.");
		expect((await writes(host.memory, "decisions/sharing.md")).map(request => request.body?.origin_device)).toEqual([
			deviceId,
		]);

		// Written on the host: the device's memory holds it, marked as the host's.
		await host.app.page.evaluate(
			ref => window.omp.aiMemory.writePage({ ...ref, title: "Jev", kind: "decision", body: "Pin Jev 1.14." }),
			{ ...ALPHA, path: "decisions/jev.md" },
		);
		await expect.poll(() => readBody(mac.app.page, "decisions/jev.md"), { timeout: 30_000 }).toBe("Pin Jev 1.14.");
		expect((await writes(device.memory, "decisions/jev.md")).map(request => request.body?.origin_device)).toEqual([
			hostId,
		]);

		// Three more rounds (each lists the host's projects twice: pull and push) write neither page again anywhere.
		const rounds = async () =>
			(await win.memory.requests()).filter(request => request.path === "/api/v1/projects").length;
		const before = await rounds();
		await expect.poll(rounds, { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 6);
		for (const [memory, file] of [
			[host.memory, "decisions/sharing.md"],
			[device.memory, "decisions/sharing.md"],
			[host.memory, "decisions/jev.md"],
			[device.memory, "decisions/jev.md"],
		] as const) {
			expect(await writes(memory, file)).toHaveLength(1);
		}
		expect(host.app.errors).toEqual([]);
		expect(device.app.errors).toEqual([]);
	} finally {
		if (device) await exitApp(device.app.app);
		if (host) await exitApp(host.app.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
