/**
 * Memory shared between two paired computers (src/main/ai-memory/sync.ts) on the built app: two apps on the fake
 * Tailscale, each with its own fake ai-memory server (e2e/fixture/fake-ai-memory.ts). The device connects to the host;
 * a decision written on either side becomes readable on the other, marked with the computer it came from, and is never
 * written back. So do the session conclusions each server captured (its seeded Stop observations): they reach the
 * other server through `/admin/write-conclusions` under the capturing computer's id, answer its `memory_query
 * {conclusions: true}`, and no later round writes one back or twice. The rules (hashes, conflicts, durable folders,
 * memory off, a blocked device, redaction, cursors) are pinned by src/main/ai-memory/sync.test.ts and the host.memory
 * cases of src/main/remote/host-services.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
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
async function computer(
	parent: string,
	name: string,
	seeded: Record<string, string>[],
	port?: number,
): Promise<Computer> {
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
			FAKE_AI_MEMORY_CONCLUSIONS: JSON.stringify(seeded),
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

const WriteConclusions = z.object({
	origin_device: z.string(),
	conclusions: z.array(z.object({ id: z.string() })),
});
const QueryAnswer = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) });
const QueryHits = z.object({ conclusion_hits: z.array(z.object({ session_id: z.string() })).optional() });

/** One entry per `/admin/write-conclusions` request a computer's server got: who captured them, which ids. */
const conclusionWrites = async (memory: FixtureAiMemory) =>
	(await memory.requests())
		.filter(request => request.path === "/admin/write-conclusions")
		.map(request => WriteConclusions.parse(request.body))
		.map(body => ({ origin: body.origin_device, ids: body.conclusions.map(item => item.id) }));

/** A computer's own memory server and its root token, as a session in it would reach them. */
async function serverOf(computer: Computer): Promise<{ url: string; headers: Record<string, string> }> {
	const { serverUrl, dataDir } = await computer.app.page.evaluate(() => window.omp.aiMemory.getState());
	const token = (await fs.readFile(path.join(String(dataDir), "auth-tokens", "default"), "utf8")).trim();
	return {
		url: String(serverUrl),
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
	};
}

/** The sessions `memory_query {conclusions: true}` answers on a computer's own server. */
async function conclusionHits(computer: Computer, query: string): Promise<string[]> {
	const server = await serverOf(computer);
	const response = await fetch(`${server.url}/mcp`, {
		method: "POST",
		headers: server.headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "memory_query", arguments: { ...ALPHA, query, conclusions: true, limit: 8 } },
		}),
	});
	const text = QueryAnswer.parse(await response.json()).result.content[0]?.text ?? "{}";
	return (QueryHits.parse(JSON.parse(text)).conclusion_hits ?? []).map(hit => hit.session_id);
}

const HOST_CONCLUSION = {
	project: "alpha",
	id: "obs-win-1",
	session_id: "s-win-1",
	title: "Pairing fix",
	body: "Host finished the pairing fix: Tailscale identity only.",
};
const DEVICE_CONCLUSION = {
	project: "alpha",
	id: "obs-mac-1",
	session_id: "s-mac-1",
	title: "Sync retries",
	body: "Device settled the retry backoff for memory sync.",
};

test("a decision made on one computer is in the other's memory, and never comes back", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-sync-")));
	let host: Computer | undefined;
	let device: Computer | undefined;
	try {
		const win = await computer(parent, "win", [HOST_CONCLUSION]);
		host = win;
		const mac = await computer(parent, "mac", [DEVICE_CONCLUSION], win.app.profile.port);
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

		// The host retires the device's decision, as the memory upkeep's supersede does: written again expired now.
		const { serverUrl, dataDir } = await win.app.page.evaluate(() => window.omp.aiMemory.getState());
		const token = (await fs.readFile(path.join(String(dataDir), "auth-tokens", "default"), "utf8")).trim();
		const retired = await fetch(`${serverUrl}/admin/write-page`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				...ALPHA,
				path: "decisions/sharing.md",
				title: "Sharing",
				kind: "decision",
				body: "Tailscale only.\n\n_Superseded by [[decisions/sharing-v2.md]]._",
				tags: ["superseded"],
				expires_at: new Date().toISOString(),
			}),
		});
		expect(retired.ok).toBe(true);
		const listed = (page: Page) =>
			page.evaluate(ref => window.omp.aiMemory.pages(ref).then(pages => pages.map(found => found.path)), ALPHA);
		await expect.poll(() => listed(mac.app.page), { timeout: 30_000 }).not.toContain("decisions/sharing.md");
		expect((await writes(device.memory, "decisions/sharing.md")).at(-1)?.body?.expires_at).toBeTruthy();
		// Retired on both, and no round brings it back live.
		const settled = await rounds();
		await expect.poll(rounds, { timeout: 30_000 }).toBeGreaterThanOrEqual(settled + 4);
		expect(await listed(win.app.page)).not.toContain("decisions/sharing.md");
		expect(await listed(mac.app.page)).not.toContain("decisions/sharing.md");
		// The copy the device's push wrote, then the retire: nothing after.
		expect(await writes(host.memory, "decisions/sharing.md")).toHaveLength(2);

		// Each computer's own conclusion is in the other's server exactly once, under the computer that captured it,
		// and answers its memory_query. Nothing was written back to where it came from in all the rounds above.
		expect(await conclusionWrites(host.memory)).toEqual([{ origin: deviceId, ids: ["obs-mac-1"] }]);
		expect(await conclusionWrites(device.memory)).toEqual([{ origin: hostId, ids: ["obs-win-1"] }]);
		expect(await conclusionHits(host, "backoff")).toEqual(["s-mac-1"]);
		expect(await conclusionHits(device, "pairing")).toEqual(["s-win-1"]);

		// One captured later on the host follows, and again no round repeats or returns anything.
		const hostServer = await serverOf(win);
		const captured = await fetch(`${hostServer.url}/__fake/capture`, {
			method: "POST",
			headers: hostServer.headers,
			body: JSON.stringify({
				project: "alpha",
				id: "obs-win-2",
				session_id: "s-win-2",
				title: "Windows build",
				body: "Host fixed the installer signing.",
			}),
		});
		expect(captured.ok).toBe(true);
		await expect.poll(() => conclusionHits(mac, "installer"), { timeout: 30_000 }).toEqual(["s-win-2"]);
		const afterLate = await rounds();
		await expect.poll(rounds, { timeout: 30_000 }).toBeGreaterThanOrEqual(afterLate + 4);
		expect(await conclusionWrites(host.memory)).toEqual([{ origin: deviceId, ids: ["obs-mac-1"] }]);
		expect(await conclusionWrites(device.memory)).toEqual([
			{ origin: hostId, ids: ["obs-win-1"] },
			{ origin: hostId, ids: ["obs-win-2"] },
		]);
		expect(host.app.errors).toEqual([]);
		expect(device.app.errors).toEqual([]);
	} finally {
		if (device) await exitApp(device.app.app);
		if (host) await exitApp(host.app.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
