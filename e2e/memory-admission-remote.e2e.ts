import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { capture, controlToolCaller, exitApp, openedSessions, openSidebarFamily, untilAnswered } from "./harness";
import {
	connectHost,
	launchRemote,
	makeRemoteProfile,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

// A paired device's agent work waits for the memory of the computer that runs it: the host decides for the sessions it
// runs (`host-services.ts #command`, the owner's rule of 2 Nov 2026 in src/main/memory-admission.ts). Here the host
// reads 3 GB free of 16 (OMP_GUI_TEST_MEMORY, a file this spec rewrites) and the device ample. An agent on the device
// opens three sessions on the host: the host holds them and says so in the tool result, the device's tabs and its pane
// show the wait with the host's figures, the host's own sidebar lists them as waiting; freeing the host's memory starts
// them, and Start now on the device's row starts one at once. The policy is unit-tested in memory-admission.test.ts and
// remote/host-services.test.ts; this runs both apps and the link between them.

const WAITING = /waiting for memory: 3 GB free of 16 GB \(pressure normal\); #\d in line; it starts by itself/g;

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;
let hostProfile: RemoteProfile;
let memory: string;

const setMemory = (availableGb: number) =>
	fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb, pressure: "normal" }));

test.beforeEach(async () => {
	parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-memory-remote-"));
	memory = path.join(parent, "host-memory.json");
	// 3 GB free of 16: less than one expected session (2.5 GB) above the 2.4 GB kept free.
	await setMemory(3);
	hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		env: { OMP_GUI_TEST_MEMORY: memory, OMP_GUI_TEST_MEMORY_MS: "200" },
	});
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	await connectHost(host.page, client.page, "PC-B");
	await expect
		.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state, {
			timeout: 30_000,
		})
		.toBe("online");
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Each tab's place in the host's line as `page`'s tab list shows it, or 0 when it does not wait. */
async function positions(page: Page, ids: readonly string[]): Promise<number[]> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	return ids.map(id => tabs.find(tab => tab.tabId === id)?.memoryWait?.position ?? 0);
}

async function hostLog(): Promise<Array<{ source?: string; message?: string }>> {
	const text = await fs.readFile(path.join(hostProfile.desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { source?: string; message?: string });
}

test("sessions a device's agent opens on a host short of memory wait there, show the wait on both computers and start when it frees", async () => {
	test.setTimeout(240_000);
	if (!host || !client) throw new Error("no apps");
	const call = await controlToolCaller(client.page, client.profile.record);
	const open = await call("ompdesk_session_open", {
		show: "focus",
		sessions: [1, 2, 3].map(n => ({ device: "PC-B", message: `Remote task ${n}` })),
	});
	expect(open.isError, open.text).toBe(false);
	const ids = openedSessions(open.text);
	expect(ids).toHaveLength(3);
	// The host's answer, as the agent reads it: held, with the host's figures, and not to be sent again.
	expect(open.text.match(WAITING)).toHaveLength(3);
	expect(open.text).toContain("do not send it again");

	// The device's tabs carry the wait (the host's line, 1..3), and nothing ran on the host's omp yet. `sessions[]` opens
	// in parallel (`#openMany`), so which session reaches the host first, and takes #1, is not the argument order.
	const lineOf = async () => [...(await positions(client?.page as Page, ids))].sort();
	await expect.poll(lineOf, { timeout: 30_000 }).toEqual([1, 2, 3]);
	expect(await lineOf()).toEqual([1, 2, 3]);
	const asked = (await fs.readFile(hostProfile.record, "utf8").catch(() => ""))
		.split("\n")
		.filter(line => line.includes("Remote task"));
	expect(asked).toEqual([]);

	// The device's window shows the row on the first tab (shown with `show: "focus"`), with the host's memory.
	const row = client.page.locator("[data-memory-wait]");
	await expect(row).toContainText("Waiting for memory: 3 GB free of 16 GB · #1 in line · starts by itself");
	await expect(row.getByRole("button", { name: "Start now" })).toBeVisible();
	await capture(client.page, "device-waiting");
	// The device's sidebar nests the three under the opener and says it on each family row, in words, with Start now.
	await openSidebarFamily(client.page);
	const familyRows = client.page.locator("[data-sidebar-opened-session][data-family-state='queued']");
	await expect(familyRows).toHaveCount(3);
	await expect(familyRows.locator("[data-family-memory-wait]")).toHaveText(Array(3).fill("Waiting for memory"));
	await expect(familyRows.getByRole("button", { name: "Start now" })).toHaveCount(3);

	// The host's own sidebar lists the sessions it runs for the device as waiting.
	await expect(host.page.locator(".omp-session-sidebar").getByText("Waiting for memory")).toHaveCount(3, {
		timeout: 30_000,
	});
	await capture(host.page, "host-waiting");

	// The host's memory frees: the three start by themselves, in line order, and answer.
	await setMemory(13);
	await expect.poll(async () => positions(client?.page as Page, ids), { timeout: 60_000 }).toEqual([0, 0, 0]);
	for (const id of ids) await untilAnswered(client.page, id);
	await expect(host.page.locator(".omp-session-sidebar").getByText("Waiting for memory")).toHaveCount(0);
	const lines = await hostLog();
	expect(lines.filter(line => line.source === "memory" && line.message === "memory hold")).toHaveLength(3);
	expect(
		lines.filter(line => line.source === "memory" && line.message === "memory release").length,
	).toBeGreaterThanOrEqual(3);
});

test("Start now on the device's row starts that session on the host at once, the rest keep waiting", async () => {
	test.setTimeout(180_000);
	if (!host || !client) throw new Error("no apps");
	const call = await controlToolCaller(client.page, client.profile.record);
	// Two sessions; the first is shown in the device's window.
	const first = await call("ompdesk_session_open", { device: "PC-B", message: "Remote first", show: "focus" });
	const second = await call("ompdesk_session_open", { device: "PC-B", message: "Remote second" });
	const [one] = openedSessions(first.text);
	const [two] = openedSessions(second.text);
	expect(first.text).toContain("waiting for memory");
	expect(second.text).toContain("waiting for memory");
	await expect
		.poll(async () => positions(client?.page as Page, [one as string, two as string]), { timeout: 30_000 })
		.toEqual([1, 2]);

	await client.page.locator("[data-memory-wait]").getByRole("button", { name: "Start now" }).click();
	await untilAnswered(client.page, one as string);
	// Its own start, whatever the host's memory says; the other is still in line, now first.
	await expect
		.poll(async () => positions(client?.page as Page, [one as string, two as string]), { timeout: 30_000 })
		.toEqual([0, 1]);
	expect((await hostLog()).some(line => line.source === "memory" && line.message === "memory start now")).toBe(true);
	const prompts = (await fs.readFile(hostProfile.record, "utf8")).split("\n").filter(line => line.includes("Remote"));
	expect(prompts.some(line => line.includes("Remote first"))).toBe(true);
	expect(prompts.some(line => line.includes("Remote second"))).toBe(false);
});
