/**
 * A browser sign-in on a paired host's tab, finished in THIS computer's browser. Stock's flow on the host (B)
 * advertises its loopback callback (`http://127.0.0.1:<port>/callback`) as the redirect, so the provider sends this
 * computer's (A's) browser to A's own loopback. A's main stands in on that port while B's login runs, hands the
 * callback over the link (`host.signIn.callback`), B replays it to its omp's own callback server and the page that
 * server answers comes back to A's browser: the sign-in completes with nothing copied by hand.
 *
 * Both apps share one computer here, so B's callback port is already taken on the loopback A would listen on:
 * A listens on `OMP_GUI_TEST_SIGN_IN_RELAY_PORT` instead (the port itself is covered by
 * `src/main/remote/sign-in-relay.test.ts`). The "browser" is this test, as in oauth-login.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { exitApp, readRecords } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

test("a host's browser sign-in comes back through this computer's loopback and completes on the host", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sign-in-relay-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const relayPort = await freePort();
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			env: { OMP_GUI_TEST_LOGIN: "1" },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
			env: { OMP_GUI_TEST_SIGN_IN_RELAY_PORT: String(relayPort) },
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		await client.app.evaluate(({ shell }) => {
			const opened: string[] = [];
			Object.assign(globalThis, { openedUrls: opened });
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		const deviceId = await connectHost(host.page, a, "Host B");
		await openHostFolder(a, deviceId, hostProfile.project);

		const settings = a.locator("[data-settings-page]");
		await a.keyboard.press("ControlOrMeta+Comma");
		await settings.locator('[data-settings-section="models"]').click();
		await settings.getByRole("button", { name: "Add a provider" }).click();
		const panel = settings.locator("[data-login-panel]");
		await settings.locator('button[data-provider-connect="anthropic"]').click();
		await expect(panel.locator("[data-login-progress]")).toHaveText(en["providerList.login.waiting"] ?? "", {
			timeout: 30_000,
		});
		// The browser comes back to this computer: the panel says so, and the code paste waits behind its toggle.
		await expect(panel.locator("[data-remote-login-hint]")).toHaveText(
			(en["providerList.login.relayHint"] ?? "").replace("{name}", "Host B"),
		);
		await expect(panel.getByLabel(en["providerList.login.pasteLabel"] ?? "")).toHaveCount(0);

		// "Sign in with browser" opens the provider's page in this computer's browser.
		await panel.getByRole("button", { name: en["providerList.login.openBrowser"] }).click();
		const app = client.app;
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
		const [authorize] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
		expect(authorize).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
		const authorization = new URL(authorize ?? "");
		const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
		expect(redirect.hostname).toBe("127.0.0.1");

		// The provider sends the browser to the callback on THIS computer's loopback (the stand-in's port here).
		const callback = new URL(`http://127.0.0.1:${relayPort}${redirect.pathname}`);
		callback.searchParams.set("code", "abc");
		callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
		const page = await fetch(callback);
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("Signed in. You can close this tab.");

		// B's omp got the callback on its own server and the sign-in completed there; A shows it connected.
		const callbacks = (await readRecords(hostProfile.record))
			.filter(frame => frame.type === "login_callback")
			.map(frame => ({ path: frame.path, query: frame.query }));
		expect(callbacks).toEqual([
			{ path: "/callback", query: { code: "abc", state: authorization.searchParams.get("state") } },
		]);
		await expect(a.getByText("Signed in to Claude")).toBeVisible({ timeout: 30_000 });
		await expect(panel.locator("[data-login-progress]")).toHaveCount(0);
		// The stand-in is gone once used.
		await expect(fetch(callback)).rejects.toThrow();
		await expect(a.locator("[data-prompt-card]")).toHaveCount(0);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
