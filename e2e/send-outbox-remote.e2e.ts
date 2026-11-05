/**
 * Messages an agent on a device (A) sends to the session it opened on a paired host (B), across a relaunch of either
 * computer (main's send outbox, `src/main/agent-control/send-outbox.ts`; the one-computer case is
 * relaunch-child-ids.e2e.ts). The child on B is busy, so A's two follow-ups wait in B's omp's queue:
 * - B relaunches: that omp and its queue end; A hands both to B's new omp once, in the order they were sent.
 * - A relaunches after a quit that leaves interrupted work to continue: B's omp keeps the child's turn and its queue;
 *   A hands nothing again, and once the turn ends the follow-ups run there once, in order. After "Quit anyway" (the
 *   setting off) the quit stopped the child on B too, and A hands both to B's new omp once, in order.
 * Either way the child's done report reaches the opener on A, and the child's id A's agent was given before the
 * relaunch takes the next message. Unit cases: send-outbox.test.ts, service.test.ts ("messages that outlive the omp
 * they were handed to"), host.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { dispatchMark } from "../resources/gui-bridge/agent-control-contracts";
import { controlToolCaller, exitApp, readRecords } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	makeRemoteProfile,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

test.describe.configure({ mode: "parallel" });

let parent: string;
let host: RemoteInstance | null = null;
let client: RemoteInstance | null = null;

test.beforeEach(async () => {
	parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-send-outbox-")));
	host = null;
	client = null;
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function quit(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = Promise.withResolvers<void>();
	if (child.exitCode !== null || child.signalCode !== null) exited.resolve();
	else child.once("exit", () => exited.resolve());
	await app.evaluate(({ app, dialog }) => {
		dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
		setImmediate(() => app.quit());
	});
	await exited.promise;
}

const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());

/** A turn that keeps running (the fake omp's long turn), as an agent's does while it works with the control tools. */
async function busy(page: Page, tabId: string): Promise<void> {
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running with job" }),
		tabId,
	);
	await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === tabId)?.status).toBe("running");
}

/** The user messages of a session file, in journal order. */
async function userTexts(sessionPath: string): Promise<string[]> {
	const lines = (await fs.readFile(sessionPath, "utf8")).split("\n").filter(Boolean);
	const texts: string[] = [];
	for (const line of lines) {
		const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		texts.push(
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(part => (typeof part?.text === "string" ? part.text : "")).join("")
					: "",
		);
	}
	return texts;
}

/** Which dispatches the session's journal holds, one per user message that names one, in order. */
async function journaled(sessionPath: string): Promise<string[]> {
	return (await userTexts(sessionPath)).flatMap(text => /\[ompdesk dispatch (d\d+):/.exec(text)?.[1] ?? []);
}

/** How many prompts B's omps were handed that carry `dispatch`. */
async function handed(profile: RemoteProfile, dispatch: string): Promise<number> {
	return (await readRecords(profile.record)).filter(
		frame =>
			frame.type === "prompt" && typeof frame.message === "string" && frame.message.includes(dispatchMark(dispatch)),
	).length;
}

/** The done reports the opener's session holds, by dispatch. */
async function doneReports(page: Page, opener: string): Promise<string[]> {
	const transcript = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 100 }),
		opener,
	);
	const messages =
		(transcript.data as { messages?: { customType?: string; details?: Record<string, unknown> }[] } | undefined)
			?.messages ?? [];
	return messages
		.filter(message => message.customType === "ompdesk.mail" && message.details?.kind === "done")
		.map(message => String(message.details?.dispatch));
}

interface Paired {
	hostProfile: RemoteProfile;
	clientProfile: RemoteProfile;
	opener: string;
	kid: string;
	childPath: string;
	call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/**
 * B shares itself; A's agent (its opener tab, busy) opens a child on B that keeps working and sends it two
 * follow-ups, which wait in B's omp's queue. B leaves interrupted turns stopped, so its relaunched omp is idle; A
 * continues them (`resume`, the default), or its quit asks and "Quit anyway" stops them, the host's tabs included.
 * Both computers read 12 GB free of 16 GB: a start fits beside two reserved ones (2.5 GB each), not beside three.
 */
async function queuedOnHost(resume = true): Promise<Paired> {
	const memory = path.join(parent, "memory.json");
	await fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb: 12, pressure: "normal" }));
	const env = { OMP_GUI_TEST_AGENT_SWEEP_MS: "500", OMP_GUI_TEST_MEMORY: memory };
	const hostProfile = await makeRemoteProfile(parent, "b", {
		language: "en",
		theme: "light",
		port: await freePort(),
		prefs: { resumeInterrupted: false },
		env,
	});
	const clientProfile = await makeRemoteProfile(parent, "a", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
		prefs: { agentControlManage: true, ...(resume ? {} : { resumeInterrupted: false }) },
		env,
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	const a = client.page;
	await connectHost(host.page, a, "PC-B");
	await expect
		.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
		.toBe("online");
	const opener = (await tabs(a)).find(tab => tab.active)?.tabId ?? "";
	expect(opener).not.toBe("");
	await busy(a, opener);
	const call = await controlToolCaller(a, clientProfile.record, opener);

	const opened = await call("ompdesk_session_open", {
		device: "PC-B",
		folder: hostProfile.project,
		message: "Title: Part A\nDo part A fixture:running-with-job",
	});
	expect(opened.isError, opened.text).toBe(false);
	const kid = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(kid).not.toBe("");
	const child = async () => (await tabs(a)).find(tab => tab.tabId === kid);
	await expect.poll(async () => (await child())?.status, { timeout: 60_000 }).toBe("running");
	await expect.poll(async () => (await child())?.sessionPath ?? "").not.toBe("");
	const childPath = (await child())?.sessionPath ?? "";

	for (const [dispatch, message] of [
		["d2", "Also do C"],
		["d3", "Then D fixture:result-ok"],
	] as const) {
		const queued = await call("ompdesk_session_send", { session: kid, message });
		expect(queued.isError, queued.text).toBe(false);
		expect(queued.text).toContain("queued as a follow-up");
		expect(queued.text).toContain(`Dispatch ${dispatch}`);
	}
	expect(await journaled(childPath)).toEqual(["d1"]);
	expect([await handed(hostProfile, "d2"), await handed(hostProfile, "d3")]).toEqual([1, 1]);
	return { hostProfile, clientProfile, opener, kid, childPath, call };
}

test("the host relaunches: the device hands its queued follow-ups to the new omp once, in order, and hears the done report", async () => {
	test.setTimeout(300_000);
	const { hostProfile, opener, kid, childPath, call } = await queuedOnHost();
	const a = (client as RemoteInstance).page;

	await quit((host as RemoteInstance).app);
	host = null;
	host = await launchRemote(hostProfile, { ready: false });

	// B's new omp got each once (the old one's queue went with it), d2 before d3, and ran them.
	await expect.poll(() => journaled(childPath), { timeout: 90_000 }).toEqual(["d1", "d2", "d3"]);
	expect([await handed(hostProfile, "d2"), await handed(hostProfile, "d3")]).toEqual([2, 2]);
	await expect.poll(() => doneReports(a, opener), { timeout: 60_000 }).toEqual(["d3"]);

	// Several sweeps later nothing was handed or reported again.
	await a.waitForTimeout(3_000);
	expect([await handed(hostProfile, "d2"), await handed(hostProfile, "d3")]).toEqual([2, 2]);
	expect(await doneReports(a, opener)).toEqual(["d3"]);

	const next = await call("ompdesk_session_send", { session: kid, message: "And E" });
	expect(next.isError, next.text).toBe(false);
	expect(next.text).toContain("Sent to");
	await expect.poll(() => journaled(childPath), { timeout: 60_000 }).toEqual(["d1", "d2", "d3", "d4"]);
	expect(client?.errors).toEqual([]);
});

for (const resume of [true, false])
	test(`the device relaunches (${resume ? "work continues" : "Quit anyway"}): the follow-ups run on the host once, in order, and the done report reaches the relaunched opener`, async () => {
		test.setTimeout(300_000);
		const { hostProfile, clientProfile, kid: oldId, childPath } = await queuedOnHost(resume);

		await quit((client as RemoteInstance).app);
		client = null;
		client = await launchRemote(clientProfile, { project: false });
		const a = client.page;
		const opener = (await tabs(a)).find(tab => tab.active && tab.device === undefined)?.tabId ?? "";
		expect(opener).not.toBe("");
		let kid = "";
		try {
			await expect
				.poll(
					async () => {
						const tab = (await tabs(a)).find(tab => tab.sessionPath === childPath);
						kid = tab?.tabId ?? "";
						return tab?.status;
					},
					{ timeout: 60_000 },
				)
				.toMatch(/^(ready|running)$/);
		} catch (error) {
			// Nightlies 41886483957 and 41921143051 and 2 of 30 CI repeats: the relaunched A never lists the child. Its tabs, its
			// link to B and the line its launch wrote about the tabs it restored or left out say which step lost it.
			const state = await a
				.evaluate(async () => ({
					tabs: await window.omp.tabs.list(),
					hosts: (await window.omp.remote.getState()).hosts,
				}))
				.catch((cause: unknown) => `unreadable: ${String(cause)}`);
			const log = await fs
				.readFile(path.join(clientProfile.desktop, "logs", "gui-runtime.jsonl"), "utf8")
				.then(text =>
					text
						.split("\n")
						.filter(line => /tab-layout|tab\.open|session_deleted|remote/.test(line))
						.slice(-30)
						.join("\n"),
				)
				.catch((cause: unknown) => `unreadable: ${String(cause)}`);
			await test.info().attach("relaunched-opener.txt", {
				body: `child: ${childPath}\n${JSON.stringify(state, null, 1)}\n--- gui-runtime.jsonl\n${log}`,
			});
			throw error;
		}

		if (resume) {
			// The quit left the child's turn running on B, in the omp that queued both: A hands neither again.
			await a.waitForTimeout(3_000);
			expect([await handed(hostProfile, "d2"), await handed(hostProfile, "d3")]).toEqual([1, 1]);
			expect(await journaled(childPath)).toEqual(["d1"]);
			// The child's turn ends; its omp runs the follow-ups it kept.
			await a.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:finish" }), kid);
		}
		// Without it the quit stopped the child (its omp and queue went): A hands both to B's new omp once.
		const times = resume ? 1 : 2;
		await expect.poll(() => journaled(childPath), { timeout: 60_000 }).toEqual(["d1", "d2", "d3"]);
		await expect.poll(() => doneReports(a, opener), { timeout: 60_000 }).toEqual(["d3"]);

		await a.waitForTimeout(3_000);
		expect([await handed(hostProfile, "d2"), await handed(hostProfile, "d3")]).toEqual([times, times]);
		expect(await journaled(childPath)).toEqual(["d1", "d2", "d3"]);
		expect(await doneReports(a, opener)).toEqual(["d3"]);

		// The id A's agent was given before the relaunch still names the child.
		expect(kid).not.toBe(oldId);
		const call = await controlToolCaller(a, clientProfile.record, opener);
		const next = await call("ompdesk_session_send", { session: oldId, message: "And E" });
		expect(next.isError, next.text).toBe(false);
		expect(next.text).toContain("Sent to");
		// B has memory to spare: the turns it ran for A and the tab its quit closed reserve none of it any more.
		expect(next.text).not.toContain("waiting for memory");
		await expect.poll(() => journaled(childPath), { timeout: 60_000 }).toEqual(["d1", "d2", "d3", "d4"]);
		expect(client.errors).toEqual([]);
	});
