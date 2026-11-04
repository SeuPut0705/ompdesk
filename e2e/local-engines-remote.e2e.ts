import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { captureTo, exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

/**
 * A local engine that starts or stops on the HOST shows in a paired computer's open Settings › Models & accounts
 * (a tab of the host is focused there) without anyone reloading it: the host tells its devices
 * (`host.models.changed`). Two apps on the fake omp; the host's models.yml is what `host.models.list` reads.
 *
 * `OMP_GUI_LOCAL_ENGINES_SHOTS=<dir>` captures the device's window once online and once offline.
 */
const SHOTS = process.env.OMP_GUI_LOCAL_ENGINES_SHOTS;
const PROVIDER = "stand-in-engine";

test("a host's local engine comes and goes in a paired computer's open provider list", async () => {
	test.setTimeout(240_000);
	let online = false;
	const engine = http.createServer((request, response) => {
		if (online && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
		} else {
			response.writeHead(503);
			response.end();
		}
	});
	await new Promise<void>(resolve => engine.listen(0, "127.0.0.1", resolve));
	const { port } = engine.address() as AddressInfo;
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-local-engines-remote-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			env: {
				OMP_GUI_TEST_LOCAL_ENGINES: JSON.stringify([
					{ id: PROVIDER, name: "Stand-in engine", baseUrl: `http://127.0.0.1:${port}/v1` },
				]),
				OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: "400",
			},
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const deviceId = await connectHost(host.page, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);

		await a.keyboard.press("ControlOrMeta+Comma");
		const settings = a.locator("[data-settings-page]");
		await settings.locator('[data-settings-section="models"]').click();
		await expect(a.locator(`[data-settings-device-banner="${deviceId}"]`)).toBeVisible();
		const row = settings.locator(`#settings-models-custom [data-custom-provider="${PROVIDER}"]`);
		await expect(settings.locator("[data-local-engine-detect]")).toBeVisible();
		await expect(row).toHaveCount(0);

		online = true;
		await expect(row).toBeVisible({ timeout: 30_000 });
		await row.scrollIntoViewIfNeeded();
		await captureTo(SHOTS, a, "online");

		online = false;
		await expect(row).toHaveCount(0, { timeout: 30_000 });
		await captureTo(SHOTS, a, "offline");

		online = true;
		await expect(row).toBeVisible({ timeout: 30_000 });
	} finally {
		engine.close();
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true });
	}
});
