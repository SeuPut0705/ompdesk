/**
 * A paired host's tab renders a streamed reply exactly as a local tab does. The host forwards `message_update`
 * as deltas (`src/main/remote/link-events.ts`, the device asked for them in its hello) and the device rebuilds the
 * stream before its windows see it. The same fake-omp reply (thinking, text and a streaming tool call) runs in a
 * local tab and in a tab on the host, and each tab is switched away from half way through the text and back after
 * the rest was streamed: a window that attaches mid-message gets its prefix from the first update's snapshot, which
 * the device has to rebuild. What each page shows, live and committed, must be the same.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

interface Shown {
	/** Each transcript row's kind and text, in order. */
	rows: string[];
	/** How many elements of each `data-*` kind the rows hold: cards and controls the text alone does not tell apart. */
	structure: Record<string, number>;
}

async function shown(page: Page, tabId: string): Promise<Shown> {
	return page.locator(`.omp-session-pane[data-tab-id="${tabId}"]`).evaluate(pane => {
		const rows = [...pane.querySelectorAll<HTMLElement>("[data-transcript-kind][data-row-key]")];
		const structure: Record<string, number> = {};
		for (const row of rows)
			for (const element of [row, ...row.querySelectorAll("*")])
				for (const name of element.getAttributeNames())
					if (name.startsWith("data-")) structure[name] = (structure[name] ?? 0) + 1;
		const clockless = (text: string) => text.replace(/\d{1,2}:\d{2}/g, "HH:MM").replace(/\b\d+(\.\d+)?s\b/g, "Ns");
		return { rows: rows.map(row => clockless(`${row.dataset.transcriptKind}: ${row.innerText}`)), structure };
	});
}

/** `shown` once three reads 300 ms apart agree: a row that is still catching up is not the page's answer. */
async function settled(page: Page, tabId: string): Promise<Shown> {
	let last = JSON.stringify(await shown(page, tabId));
	for (let stable = 0, reads = 0; stable < 3 && reads < 40; reads++) {
		await page.waitForTimeout(300);
		const next = JSON.stringify(await shown(page, tabId));
		stable = next === last ? stable + 1 : 0;
		last = next;
	}
	return JSON.parse(last) as Shown;
}

test("a host's tab shows a streamed reply, live and finished, as a local tab does", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-stream-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const deviceId = await connectHost(host.page, a, "Host B");
		const remoteTab = await openHostFolder(a, deviceId, hostProfile.project);
		await a
			.getByRole("region", { name: "This device" })
			.getByRole("button", { name: "New agent session here" })
			.click();
		const localTab =
			(await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active && !tab.device)?.tabId ?? "";
		expect(localTab).not.toBe("");

		const activate = async (tabId: string) => {
			const pane = a.locator(`.omp-session-pane[data-tab-id="${tabId}"]`);
			if ((await pane.getAttribute("data-active", { timeout: 1_000 }).catch(() => null)) !== "true") {
				// ⌃⇥ goes to the tab used before this one: the two tabs under test are always the last two used.
				await a.keyboard.down("Control");
				await a.keyboard.press("Tab");
				await expect(a.getByRole("listbox", { name: "Open tabs, most recent first" })).toBeVisible();
				await a.keyboard.up("Control");
			}
			await expect(pane).toHaveAttribute("data-active", "true");
		};
		const command = (tabId: string, line: string) =>
			a.evaluate(([id, bash]) => window.omp.rpc.commandForTab(id, { type: "bash", command: bash }), [tabId, line]);

		const run = async (tabId: string, awayTabId: string) => {
			await activate(tabId);
			const pane = a.locator(`.omp-session-pane[data-tab-id="${tabId}"]`);
			const field = pane.locator(".omp-composer-input");
			await field.fill("fixture stream parts paused");
			await field.press("Enter");
			await expect(pane).toContainText("Streamed answer line 10.", { timeout: 30_000 });
			await expect(pane).not.toContainText("Streamed answer line 11.");
			// Lines 11 to 20 stream while another tab is in front: this page receives none of them. The first update
			// after it comes back carries the whole message so far, which is where lines 11 to 20 come from.
			await activate(awayTabId);
			await command(tabId, "fixture:parts:resume");
			await a.waitForTimeout(2_000);
			await activate(tabId);
			await command(tabId, "fixture:parts:resume");
			await expect(pane).toContainText("Streamed answer line 30.", { timeout: 30_000 });
			await expect(pane).toContainText("Streamed answer line 15.");
			// The running step shows its clock once it has run a whole second, on whichever tick of the shared clock comes
			// next: read before that, one tab's live rows had the clock and the other's not (both tabs draw it alike).
			await expect(pane.locator(".omp-work-clock")).toBeVisible({ timeout: 30_000 });
			const live = await settled(a, tabId);
			await command(tabId, "fixture:finish:parts");
			await expect(pane).toContainText("Streamed parts finished", { timeout: 30_000 });
			return { live, done: await settled(a, tabId) };
		};

		const remote = await run(remoteTab, localTab);
		const local = await run(localTab, remoteTab);

		const liveText = local.live.rows.join("\n");
		expect(liveText).toContain("Streamed answer line 1. Streamed answer line 2.");
		expect(liveText).toContain("Streamed answer line 30.");
		expect(remote.live.rows).toEqual(local.live.rows);
		expect(remote.live.structure).toEqual(local.live.structure);
		expect(remote.done.rows).toEqual(local.done.rows);
		expect(remote.done.structure).toEqual(local.done.structure);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
