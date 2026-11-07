/**
 * One session's sidebar row on the three surfaces that show a computer's sessions, asserted case by case in one run
 * (the owner's report, 8 Nov 2026, after eight per-case fixes: stale run state, subagent counts and titles in the
 * sidebar). Computer A runs the sessions. The surfaces are A's own window, a second OMPdesk B paired with A (A's device
 * section in B's sidebar) and A's phone page (Pixel 8 through the fake `tailscale serve`). Per row: `data-signal`
 * (a paired computer's rows carry none, so the title's `data-working` stands in), the family chip's running count, the
 * done mark where the surface draws one, and the title. Cases 1-11 are the `test.step`s; a failed assertion is
 * recorded and the run goes on, so one run lists every failing cell and prints the case × surface table.
 * `OMP_GUI_SUMMARY_MATRIX=<dir>` writes a capture per surface at key steps and `matrix.txt`;
 * `OMP_GUI_SUMMARY_MATRIX_ONLY=1,4` runs those cases only.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, controlToolCaller, cssString, exitApp } from "./harness";
import {
	connectHost,
	type LinkProxy,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	REMOTE_LOGIN,
	type RemoteInstance,
} from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_SUMMARY_MATRIX;
const ONLY = process.env.OMP_GUI_SUMMARY_MATRIX_ONLY?.split(",").map(item => item.trim());
const SETTLE = 15_000;

type Signal = "running" | "waiting" | "error" | "none";

/** What a row says, read from the page. */
interface RowView {
	present: boolean;
	signal: Signal;
	/** The family chip's running count; 0 without a chip. */
	running: number;
	done: boolean;
	/** The `data-working` light of the title ("turn", "background", "waiting"), "" without one. */
	working: string;
	text: string;
}

type Want = Partial<Pick<RowView, "present" | "signal" | "running" | "done">> & { title?: string };

interface Surface {
	name: "A" | "B" | "phone";
	page: Page;
	/** The element holding the surface's rows, and the attribute that names a session's row there. */
	scope: string;
	attribute: string;
	/** A computer's own rows carry `data-signal`; a paired computer's do not. */
	ownSignal: boolean;
	prepare: () => Promise<void>;
}

/** A session and the tab (on `page`'s computer, or A's for B's hosted tab) that runs it. */
interface Session {
	page: Page;
	tabId: string;
	title: string;
	path: string;
}

interface Outcome {
	id: string;
	surface: string;
	what: string;
	ok: boolean;
	detail: string;
}

type Command = { type: "prompt"; message: string } | { type: "bash"; command: string };

const tabsOf = (page: Page) => page.evaluate(() => window.omp.tabs.list());

async function runCommand(page: Page, tabId: string, command: Command): Promise<void> {
	const response = await page.evaluate(([id, body]) => window.omp.rpc.commandForTab(id, body), [
		tabId,
		command,
	] as const);
	expect(response.success, JSON.stringify(response)).toBe(true);
}

async function answered(page: Page, tabId: string): Promise<void> {
	await expect
		.poll(async () => (await tabsOf(page)).find(tab => tab.tabId === tabId)?.lastRun?.reply, { timeout: 30_000 })
		.toBe("Local fixture reply");
}

/** The block of `ompdesk_sessions`' text whose first line holds `needle`, and the subagent count it names (-1: no such row). */
function toolCount(text: string, needle: string): number {
	const block = text
		.split(/\n(?=- )/)
		.find(part => part.startsWith("- ") && (part.split("\n")[0] ?? "").includes(needle));
	if (!block) return -1;
	return Number(/(\d+) subagent\(s\) running/.exec(block)?.[1] ?? 0);
}

test("a session's row says the same on this computer, a paired computer and the phone", async () => {
	test.setTimeout(2_400_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-summary-matrix-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	let link: LinkProxy | undefined;
	const browser = await chromium.launch();
	const outcomes: Outcome[] = [];
	try {
		const hostProfile = await makeRemoteProfile(parent, "a", { language: "en", theme: "light" });
		link = await linkProxy(hostProfile.port);
		const clientProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: Number(link.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = host.page;
		const b = client.page;
		await b.evaluate(() => window.omp.remote.setDeviceName("PC-B"));
		const deviceId = await connectHost(a, b, "PC-A");
		const linkState = async () => (await b.evaluate(() => window.omp.remote.getState())).hosts[0]?.state;
		await expect.poll(linkState, { timeout: 30_000 }).toBe("online");

		await a.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => a.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(hostProfile.tailscale).at(-1);
		if (!site) throw new Error("A's Mobile web published no serve handler");
		proxy = await ServeProxy.start(site, REMOTE_LOGIN);
		const phoneContext = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await phoneContext.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);

		const drawerOf = (page: Page) => page.locator("[data-drawer] .omp-session-sidebar");
		/** Every folded project of `scope` opens: a folded group's rows are not in the page. */
		const unfold = async (page: Page, scope: string) => {
			const folded = page.locator(
				`${scope} :is(button:has([data-sidebar-workspace-icon]), button[data-roving-item^="device-group:"])[aria-expanded="false"]`,
			);
			for (const button of await folded.all()) await button.click();
		};
		const surfaces: Surface[] = [
			{
				name: "A",
				page: a,
				scope: ".omp-session-sidebar",
				attribute: "data-session-path",
				ownSignal: true,
				prepare: () => unfold(a, ".omp-session-sidebar"),
			},
			{
				name: "B",
				page: b,
				scope: `[data-sidebar-device="${deviceId.replace(/"/g, '\\"')}"]`,
				attribute: "data-device-session",
				ownSignal: false,
				prepare: async () => {
					const toggle = b.locator(`[data-sidebar-device-toggle="${deviceId}"]`);
					if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false")
						await toggle.click();
					await unfold(b, `[data-sidebar-device="${deviceId}"]`);
				},
			},
			{
				name: "phone",
				page: phone,
				scope: "[data-drawer] .omp-session-sidebar",
				attribute: "data-session-path",
				ownSignal: true,
				prepare: async () => {
					if (!(await drawerOf(phone).isVisible()))
						await phone.locator("header button:has(svg.lucide-menu)").click();
					await expect(drawerOf(phone)).toBeVisible();
					await unfold(phone, "[data-drawer] .omp-session-sidebar");
				},
			},
		];
		const surfaceB = surfaces[1] as Surface;
		const surfacePhone = surfaces[2] as Surface;

		const observe = async (surface: Surface, sessionPath: string): Promise<RowView> => {
			await surface.prepare();
			return surface.page.evaluate(
				([scope, attribute, wanted, ownSignal]) => {
					const root = document.querySelector(scope);
					const row = root
						? [...root.querySelectorAll(`[${attribute}]`)].find(
								element =>
									element.getAttribute(attribute) === wanted &&
									!element.hasAttribute("data-sidebar-opened-session"),
							)
						: undefined;
					if (!row)
						return { present: false, signal: "none", running: 0, done: false, working: "", text: "" } as const;
					const working = row.querySelector(".omp-live-text[data-working]")?.getAttribute("data-working") ?? "";
					const derived = working === "turn" ? "running" : working === "waiting" ? "waiting" : "none";
					const own = row.getAttribute("data-signal");
					const signal = (own ?? (ownSignal ? "none" : derived)) as "running" | "waiting" | "error" | "none";
					const pill = row.querySelector("[data-family-running]");
					return {
						present: true,
						signal,
						running: pill ? Number(pill.getAttribute("data-family-running")) : 0,
						done: row.querySelector("[data-sidebar-done]") !== null,
						working,
						text: row.textContent ?? "",
					};
				},
				[surface.scope, surface.attribute, sessionPath, surface.ownSignal] as const,
			);
		};

		const record = (id: string, surface: string, what: string, ok: boolean, detail = "") => {
			outcomes.push({ id, surface, what, ok, detail });
		};

		const check = async <T>(
			id: string,
			surface: string,
			what: string,
			read: () => Promise<T>,
			want: Record<string, unknown>,
			shown: (value: T) => unknown,
			timeout = SETTLE,
			wantShown: unknown = want,
		) => {
			let last: T | undefined;
			let failure = "";
			try {
				await expect
					.poll(
						async () => {
							try {
								last = await read();
								return last;
							} catch (error) {
								failure = String(error).split("\n")[0] ?? "";
								throw error;
							}
						},
						{ timeout },
					)
					.toMatchObject(want);
				record(id, surface, what, true);
			} catch {
				record(
					id,
					surface,
					what,
					false,
					`want ${JSON.stringify(wantShown)}, got ${last === undefined ? failure : JSON.stringify(shown(last))}`,
				);
			}
		};

		const expectRow = async (
			id: string,
			what: string,
			session: Session,
			want: Want,
			on: readonly Surface[] = surfaces,
		) => {
			const { title, ...rest } = want;
			await Promise.all(
				on.map(surface =>
					check(
						id,
						surface.name,
						what,
						() => observe(surface, session.path),
						title === undefined ? rest : { ...rest, text: expect.stringContaining(title) },
						view => ({
							...Object.fromEntries(Object.keys(rest).map(key => [key, view[key as keyof RowView]])),
							...(title === undefined ? {} : { title: view.text.slice(0, 80) }),
						}),
						SETTLE,
						want,
					),
				),
			);
		};

		const captureAll = async (tag: string) => {
			for (const surface of surfaces) {
				await surface.prepare().catch(() => undefined);
				await captureTo(CAPTURES, surface.page, `${tag}-${surface.name}`);
			}
		};

		const tabOf = async (session: Session) => (await tabsOf(session.page)).find(tab => tab.tabId === session.tabId);
		const shell = (session: Session, line: string) =>
			runCommand(session.page, session.tabId, { type: "bash", command: line });
		const say = (session: Session, message: string) =>
			runCommand(session.page, session.tabId, { type: "prompt", message });
		const turnRunning = async (session: Session) => {
			const tab = await tabOf(session);
			return tab?.status === "running" && tab.settling !== true;
		};
		const startTurn = async (session: Session) => {
			if (!(await turnRunning(session))) await say(session, "fixture running");
			await expect.poll(() => turnRunning(session), { timeout: 20_000 }).toBe(true);
		};
		const endTurn = async (session: Session) => {
			if ((await tabOf(session))?.status === "running") await shell(session, "fixture:finish");
			await expect.poll(async () => (await tabOf(session))?.status, { timeout: 20_000 }).toBe("ready");
		};
		const startSubagents = (session: Session) => shell(session, "fixture:subagents");
		const finishSubagent = (session: Session, id: "sa-explore" | "sa-nested") =>
			shell(session, `fixture:subagents:finish:${id}`);

		/** A named, titled session with a file: one answered turn in `tabId`. */
		const seed = async (page: Page, tabId: string, title: string): Promise<Session> => {
			await expect
				.poll(async () => (await tabsOf(page)).find(tab => tab.tabId === tabId)?.status, { timeout: 60_000 })
				.toBe("ready");
			await runCommand(page, tabId, { type: "bash", command: `fixture:title:${title}` });
			await runCommand(page, tabId, { type: "prompt", message: "hello" });
			await answered(page, tabId);
			let sessionPath = "";
			await expect
				.poll(
					async () => {
						sessionPath = (await tabsOf(page)).find(tab => tab.tabId === tabId)?.sessionPath ?? "";
						return sessionPath;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
			return { page, tabId, title, path: sessionPath };
		};

		// A's first window: a shown tab and a hidden one. A second window of A holds a tab of its own.
		const frontTab = (await tabsOf(a)).find(tab => tab.active)?.tabId ?? "";
		expect(frontTab).not.toBe("");
		const shown = await seed(a, frontTab, "Matrix shown");
		await a.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabsOf(a)).length).toBe(2);
		const hiddenTab = (await tabsOf(a)).find(tab => tab.tabId !== frontTab)?.tabId ?? "";
		const hidden = await seed(a, hiddenTab, "Matrix hidden");
		await a
			.locator(`.omp-session-sidebar .omp-sidebar-session-row[data-session-path=${cssString(shown.path)}]`)
			.click();
		await expect.poll(async () => (await tabsOf(a)).find(tab => tab.active)?.tabId).toBe(frontTab);

		expect(await a.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
		await expect.poll(() => host?.app.windows().length, { timeout: 30_000 }).toBe(2);
		const second = host.app.windows().find(page => page !== a);
		if (!second) throw new Error("A's second window has no page");
		await second.waitForFunction(() => window.omp?.rpc != null);
		const secondTab = (await tabsOf(second)).find(tab => tab.active)?.tabId ?? "";
		expect(secondTab).not.toBe("");
		const other = await seed(second, secondTab, "Matrix second window");
		expect((await tabsOf(a)).some(tab => tab.tabId === secondTab)).toBe(false);

		await phone.reload({ timeout: 60_000 });
		await phone.waitForFunction(() => window.omp?.rpc != null);
		await phonePaired(phone);
		await surfacePhone.prepare();
		await surfaceB.prepare();
		for (const session of [shown, hidden, other]) {
			for (const surface of surfaces) {
				try {
					await expect
						.poll(async () => (await observe(surface, session.path)).present, { timeout: 60_000 })
						.toBe(true);
				} catch (error) {
					await surface.page.screenshot({ path: test.info().outputPath(`not-listed-${surface.name}.png`) });
					throw new Error(`${surface.name} lists no row for "${session.title}" before any case`, { cause: error });
				}
			}
		}

		const call = await controlToolCaller(a, hostProfile.record, frontTab);
		const listing = async () => {
			const result = await call("ompdesk_sessions", { scope: "app" });
			expect(result.isError, result.text).toBe(false);
			return result.text;
		};

		const wanted = (id: string) => ONLY === undefined || ONLY.includes(id);
		const runCase = async (id: string, name: string, body: () => Promise<void>) => {
			if (!wanted(id)) return;
			await test.step(`${id}. ${name}`, async () => {
				try {
					await body();
				} catch (error) {
					record(
						id,
						"setup",
						"the case's own steps ran",
						false,
						String(error).split("\n").slice(0, 3).join(" | "),
					);
				}
			});
		};

		/** Subagents start (2), finish one by one (1, 0), on `session`, all surfaces. */
		const subagentLifecycle = async (id: string, session: Session) => {
			await startTurn(session);
			await expectRow(id, "turn running", session, {
				present: true,
				signal: "running",
				running: 0,
				title: session.title,
			});
			await startSubagents(session);
			await expectRow(id, "two subagents start", session, { signal: "running", running: 2 });
			await captureAll(`${id}-subagents-running`);
			await finishSubagent(session, "sa-explore");
			await expectRow(id, "one subagent finished", session, { signal: "running", running: 1 });
			await finishSubagent(session, "sa-nested");
			await expectRow(id, "all subagents finished", session, { signal: "running", running: 0 });
			await captureAll(`${id}-subagents-finished`);
		};

		await runCase("1", "a hidden tab's session: subagents start and finish", () => subagentLifecycle("1", hidden));

		await runCase("2", "a session held by A's second window only", async () => {
			await subagentLifecycle("2", other);
			await endTurn(other);
		});

		await runCase("3", "a session B never opened, shown on A", async () => {
			await subagentLifecycle("3", shown);
			await endTurn(shown);
			await expectRow("3", "turn ended", shown, { signal: "none", running: 0 });
		});

		const presence = (state: "hidden" | "visible") =>
			phone.evaluate(next => {
				Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
				Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
				document.dispatchEvent(new Event("visibilitychange"));
			}, state);

		await runCase("4", "the phone: screen off, page reload, reconnect", async () => {
			await startTurn(hidden);
			await expectRow("4", "turn running", hidden, { signal: "running", running: 0 });
			await presence("hidden");
			await startSubagents(hidden);
			await presence("visible");
			await expectRow("4", "subagents started while the screen was off", hidden, { signal: "running", running: 2 });
			await captureAll("4-screen-back");
			await phone.reload({ timeout: 60_000 });
			await phone.waitForFunction(() => window.omp?.rpc != null);
			await phonePaired(phone);
			await expectRow("4", "after the page reloaded", hidden, { signal: "running", running: 2 }, [surfacePhone]);
			const outage = proxy?.outage("refuse");
			await finishSubagent(hidden, "sa-explore");
			await expectRow("4", "one finished while the phone was offline", hidden, { running: 1 }, [
				surfaces[0] as Surface,
				surfaceB,
			]);
			outage?.restore();
			await expectRow("4", "after the phone reconnected", hidden, { signal: "running", running: 1 }, [surfacePhone]);
			await finishSubagent(hidden, "sa-nested");
			await expectRow("4", "all finished", hidden, { signal: "running", running: 0 });
		});

		await runCase("5", "the paired link drops and comes back", async () => {
			if (!link) throw new Error("no relay");
			await startTurn(hidden);
			for (const [round, change, running] of [
				["subagents start while the link is down", () => startSubagents(hidden), 2],
				[
					"subagents end while the link is down",
					async () => {
						await finishSubagent(hidden, "sa-explore");
						await finishSubagent(hidden, "sa-nested");
					},
					0,
				],
			] as const) {
				await link.drop();
				await expect.poll(linkState, { timeout: 30_000 }).not.toBe("online");
				await change();
				await expectRow("5", `${round}: A`, hidden, { running }, [surfaces[0] as Surface]);
				await link.restore();
				await expect.poll(linkState, { timeout: 60_000 }).toBe("online");
				await expectRow("5", `${round}: after restore`, hidden, { signal: "running", running });
			}
			await captureAll("5-link-restored");
		});

		await runCase("6", "the tab's omp is killed with subagents running", async () => {
			test.skip(process.platform === "win32", "the omp's pid comes from ps");
			await startTurn(hidden);
			await startSubagents(hidden);
			await expectRow("6", "subagents running before the crash", hidden, { signal: "running", running: 2 });
			const state = await a.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "get_state", brief: true }),
				hidden.tabId,
			);
			const pid = Number((state.data as { sessionId?: string } | undefined)?.sessionId?.replace("fixture-", ""));
			expect(pid).toBeGreaterThan(0);
			const fakes = () =>
				execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
					.split("\n")
					.filter(line => line.includes(hostProfile.root) && line.includes("rpc-ui"))
					.map(line => Number.parseInt(line, 10));
			const before = fakes().length;
			process.kill(pid, "SIGKILL");
			await expect
				.poll(
					() => {
						const now = fakes();
						return now.length === before && !now.includes(pid);
					},
					{ timeout: 60_000 },
				)
				.toBe(true);
			await expect.poll(async () => (await tabOf(hidden))?.status, { timeout: 60_000 }).toBe("ready");
			await expectRow("6", "the dead omp's subagents dropped", hidden, { signal: "none", running: 0 });
			await captureAll("6-after-crash");
			await startTurn(hidden);
			await startSubagents(hidden);
			await expectRow("6", "a new turn's subagents count again", hidden, { signal: "running", running: 2 });
			await finishSubagent(hidden, "sa-explore");
			await finishSubagent(hidden, "sa-nested");
			await expectRow("6", "and end", hidden, { running: 0 });
		});

		await runCase("7", "waiting for the person, answered by an agent", async () => {
			await endTurn(hidden);
			await say(hidden, "fixture approval");
			await expectRow("7", "waiting", hidden, { signal: "waiting" });
			await captureAll("7-waiting");
			const answer = await call("ompdesk_session_answer", {
				session: hidden.tabId,
				request: "approval",
				choice: "Deny",
			});
			expect(answer.isError, answer.text).toBe(false);
			await Promise.all(
				surfaces.map(surface =>
					check(
						"7",
						surface.name,
						"the waiting mark left",
						() => observe(surface, hidden.path),
						{ present: true, signal: expect.not.stringMatching(/^waiting$/) },
						view => ({ signal: view.signal }),
						SETTLE,
						{ signal: "not waiting" },
					),
				),
			);
		});

		await runCase("8", "a title change", async () => {
			hidden.title = "Matrix hidden renamed";
			await a.evaluate(([file, name]) => window.omp.sessions.rename(file, name), [
				hidden.path,
				hidden.title,
			] as const);
			await expectRow("8", "new title", hidden, { present: true, title: hidden.title });
			await captureAll("8-renamed");
		});

		await runCase("9", "the turn ends to idle", async () => {
			await startTurn(hidden);
			await expectRow("9", "turn running", hidden, { signal: "running" });
			await shell(hidden, "fixture:finish");
			await expectRow("9", "running left", hidden, { signal: "none", running: 0 });
			await expectRow("9", "done mark", hidden, { done: true }, [surfaces[0] as Surface]);
			await captureAll("9-finished");
		});

		const agree = async (id: string, what: string, session: Session, needle: string) => {
			let last: { tool: number; rows: Record<string, number> } = { tool: -2, rows: {} };
			const mismatched = () =>
				surfaces.filter(surface => last.rows[surface.name] !== last.tool).map(surface => surface.name);
			const settled = await expect
				.poll(
					async () => {
						const tool = toolCount(await listing(), needle);
						const rows: Record<string, number> = {};
						for (const surface of surfaces) rows[surface.name] = (await observe(surface, session.path)).running;
						last = { tool, rows };
						return mismatched().join(",");
					},
					{ timeout: SETTLE },
				)
				.toBe("")
				.then(
					() => true,
					() => false,
				);
			for (const surface of surfaces)
				record(
					id,
					surface.name,
					what,
					settled || !mismatched().includes(surface.name),
					`the row says ${last.rows[surface.name]}, ompdesk_sessions says ${last.tool < 0 ? "no such session" : last.tool}`,
				);
		};

		await runCase("10", "a row's subagent count equals ompdesk_sessions' count", async () => {
			await startTurn(hidden);
			await startSubagents(hidden);
			await agree("10", "two subagents: row = tool (a tab of A's window)", hidden, hidden.tabId);
			await finishSubagent(hidden, "sa-explore");
			await agree("10", "one subagent: row = tool (a tab of A's window)", hidden, hidden.tabId);
			await finishSubagent(hidden, "sa-nested");
			await endTurn(hidden);

			// B opens a tab on A: A runs it for B and the tool must list it.
			const hostedTab = await openHostFolder(b, deviceId, hostProfile.project);
			const hosted = await seed(b, hostedTab, "Matrix hosted for B");
			await startTurn(hosted);
			await startSubagents(hosted);
			await expectRow("10", "hosted for B: subagents running", hosted, {
				signal: "running",
				running: 2,
				title: hosted.title,
			});
			await agree("10", "two subagents: row = tool (a tab A runs for B)", hosted, `"${hosted.title}"`);
			await captureAll("10-hosted-for-peer");
		});

		await runCase("11", "A deletes a session B holds a tab of", async () => {
			const hosted = (await tabsOf(b)).find(tab => tab.device === deviceId && tab.title === "Matrix hosted for B");
			if (!hosted?.sessionPath) throw new Error("case 10 left no hosted tab on B");
			const session: Session = {
				page: b,
				tabId: hosted.tabId,
				title: "Matrix hosted for B",
				path: hosted.sessionPath,
			};
			await finishSubagent(session, "sa-explore");
			await finishSubagent(session, "sa-nested");
			await endTurn(session);
			await expectRow("11", "the session is listed before the delete", session, { present: true });
			await a.evaluate(file => window.omp.sessions.delete(file), session.path);
			await check(
				"11",
				"B",
				"B's tab of it closed",
				async () => ({ held: (await tabsOf(b)).some(tab => tab.tabId === session.tabId) }),
				{ held: false },
				value => value,
			);
			await expectRow("11", "the row left", session, { present: false });
			await captureAll("11-deleted");

			// The same on A itself: a session A's second window holds a tab of.
			await endTurn(other);
			await expectRow("11", "A's second window's session is listed before the delete", other, { present: true });
			await a.evaluate(file => window.omp.sessions.delete(file), other.path);
			await check(
				"11",
				"A",
				"A's second window's tab of it closed",
				async () => ({
					held: await tabsOf(second).then(
						tabs => tabs.some(tab => tab.tabId === other.tabId),
						() => false,
					),
				}),
				{ held: false },
				value => value,
			);
			await expectRow("11", "A's second window's session row left", other, { present: false });
			await captureAll("11-second-window-deleted");
		});

		const lines: string[] = [];
		const caseIds = [...new Set(outcomes.map(outcome => outcome.id))].sort((x, y) => Number(x) - Number(y));
		for (const id of caseIds) {
			for (const surface of ["A", "B", "phone", "setup"]) {
				const results = outcomes.filter(outcome => outcome.id === id && outcome.surface === surface);
				if (results.length === 0) continue;
				const failed = results.filter(result => !result.ok);
				lines.push(
					failed.length === 0
						? `case ${id} ${surface}: PASS (${results.length} checks)`
						: `case ${id} ${surface}: FAIL (${failed.length} of ${results.length} checks)`,
					...failed.map(result => `    ${result.what}: ${result.detail}`),
				);
			}
		}
		const table = lines.join("\n");
		console.log(`\n${table}\n`);
		await test.info().attach("matrix.txt", { body: table, contentType: "text/plain" });
		if (CAPTURES) {
			await fs.mkdir(CAPTURES, { recursive: true });
			await fs.writeFile(path.join(CAPTURES, "matrix.txt"), `${table}\n`);
		}
		expect(
			outcomes
				.filter(outcome => !outcome.ok)
				.map(outcome => `case ${outcome.id} ${outcome.surface}: ${outcome.what}: ${outcome.detail}`),
			"failing cells",
		).toEqual([]);
		await phoneContext.close();
	} finally {
		await proxy?.close();
		await link?.close();
		await browser.close();
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
