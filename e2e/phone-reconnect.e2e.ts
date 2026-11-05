/**
 * The phone's link to the computer drops and comes back, on the built app's real web page behind the fake `tailscale
 * serve` (e2e/fixture/phone-serve.ts plays the network: a cut, a refused network, a dead route that swallows what is
 * sent, a socket that went silent while the phone slept), while the phone views a running session with a draft in its
 * composer and the transcript scrolled up:
 *
 * - A drop that heals within the grace shows nothing; the transcript (same DOM, same scroll), the draft and the work
 *   strip stay as they were, and no page load happens.
 * - A longer drop shows only the title bar's own status turning to "Reconnecting to your computer…"
 *   (`.omp-titlebar-status[data-tone="offline"]`), which covers none of the header's controls nor the work strip at
 *   390 and 412 px, and goes the moment the link is back.
 * - A socket that went silent (a dead route: requests never answered, even after the network is back) is given up
 *   within seconds, and so is a ticket request sent on it; a return from the background over a link that died asleep
 *   reconnects within seconds too, not after the browser's own request timeout or the minute-long heartbeat.
 * - A message sent while the link is down reaches the computer once the link is back, exactly once.
 *
 * Every scenario's numbers (time to reconnect, how long a notice showed, the calls the page made to catch up and the
 * bytes it received) go into `reconnect-numbers.json`. `OMP_GUI_PHONE_RECONNECT=<dir>` also writes the captures
 * (390 px, light and dark: connected, long drop, reconnected) there. The transport's rules are unit-tested in
 * ws-transport.test.ts, the status in link-status.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

const ENGINES: { name: string; type: BrowserType; device: (typeof devices)[string] }[] = [
	// 390 px wide.
	{ name: "webkit", type: webkit, device: devices["iPhone 14"] },
	// 412 px wide.
	{ name: "chromium", type: chromium, device: devices["Pixel 7"] },
];

const CAPTURES = process.env.OMP_GUI_PHONE_RECONNECT;

/** What the page saw of its link: sockets, hellos, the calls it made and the notices it showed, by `performance.now()`. */
interface LinkLog {
	log: { at: number; what: string; detail?: unknown }[];
	calls: { at: number; ch: string }[];
	bytesDown: { at: number; n: number }[];
}

/** Records the page's link: installed before the page's own scripts, so it wraps the transport's `WebSocket`. */
function watchLink(): void {
	const link: LinkLog = { log: [], calls: [], bytesDown: [] };
	Reflect.set(window, "__link", link);
	const note = (what: string, detail?: unknown) => link.log.push({ at: performance.now(), what, detail });
	// The ticket request of each connection attempt (`/api/ticket`-style fetches), so the timeline shows where the time went.
	const nativeFetch = window.fetch.bind(window);
	window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
		const watched = url.includes("/api/");
		if (watched) note("fetch:start", new URL(url, location.href).pathname);
		try {
			const response = await nativeFetch(input, init);
			if (watched) note("fetch:end", `${new URL(url, location.href).pathname} ${response.status}`);
			return response;
		} catch (error) {
			if (watched) note("fetch:failed", `${new URL(url, location.href).pathname} ${String(error).slice(0, 60)}`);
			throw error;
		}
	}) as typeof fetch;
	const Native = window.WebSocket;
	class Watched extends Native {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			note("ws:new", Array.isArray(protocols) ? protocols.some(p => p.startsWith("resume.")) : false);
			this.addEventListener("close", event => note("ws:close", event.code));
			this.addEventListener("message", event => {
				if (typeof event.data !== "string") return;
				link.bytesDown.push({ at: performance.now(), n: event.data.length });
				if (event.data.startsWith('{"t":"hello"')) note("hello", JSON.parse(event.data).resumed === true);
			});
		}
		send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			if (typeof data === "string" && data.startsWith('{"t":"inv"')) {
				const frame = JSON.parse(data) as { ch: string };
				link.calls.push({ at: performance.now(), ch: frame.ch });
			}
			super.send(data);
		}
	}
	window.WebSocket = Watched;
	// The old full-width bar and the header's link status, each as a notice the person sees.
	let shown = "";
	const check = () => {
		const bar = document.getElementById("omp-web-connection");
		const status = document.querySelector<HTMLElement>('.omp-titlebar-status[data-tone="offline"]');
		const now = bar ? "bar" : status && status.getClientRects().length > 0 ? "status" : "";
		if (now === shown) return;
		shown = now;
		note(now ? `notice:${now}` : "notice:none");
	};
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
}

interface Numbers {
	scenario: string;
	/** From the network coming back (or the drop, for a blip) to the host's hello on the new socket. */
	reconnectMs: number | null;
	resumed: boolean | null;
	noticeShownMs: number;
	notices: string[];
	calls: string[];
	bytesDownAfter: number;
	draftKept: boolean;
	/** How far the row the person was reading moved on screen (the scroller may move to hold it still). */
	scrollMovedPx: number | null;
	transcriptKept: boolean;
	pageLoads: number;
	timeline: string[];
}

async function now(phone: Page): Promise<number> {
	return phone.evaluate(() => performance.now());
}

async function linkLog(phone: Page): Promise<LinkLog> {
	return phone.evaluate(() => Reflect.get(window, "__link") as LinkLog);
}

/** The first hello after `since`, in `performance.now()` time; null if none came within `timeoutMs`. */
async function helloAfter(
	phone: Page,
	since: number,
	timeoutMs: number,
): Promise<{ at: number; resumed: boolean } | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hello = (await linkLog(phone)).log.find(entry => entry.what === "hello" && entry.at > since);
		if (hello) return { at: hello.at, resumed: hello.detail === true };
		await phone.waitForTimeout(50);
	}
	return null;
}

/** How long any notice was on screen between `from` and `to`, and which kinds. */
function noticeTime(log: LinkLog, from: number, to: number): { ms: number; kinds: string[] } {
	let ms = 0;
	let since: number | null = null;
	const kinds = new Set<string>();
	// The state at `from`: the last notice entry before it.
	const before = log.log.filter(entry => entry.what.startsWith("notice:") && entry.at <= from).at(-1);
	if (before && before.what !== "notice:none") {
		since = from;
		kinds.add(before.what.slice(7));
	}
	for (const entry of log.log) {
		if (!entry.what.startsWith("notice:") || entry.at <= from || entry.at > to) continue;
		if (entry.what === "notice:none") {
			if (since !== null) ms += entry.at - since;
			since = null;
		} else {
			kinds.add(entry.what.slice(7));
			if (since === null) since = entry.at;
		}
	}
	if (since !== null) ms += to - since;
	return { ms: Math.round(ms), kinds: [...kinds] };
}

/**
 * The transcript's scroller (the same element?) and the row the person reads: the topmost one wholly in view, by its key
 * and the distance of its text from the scroller's top. A re-read may change rows (a prompt gains "from <device>"), and
 * the list then holds the topmost row it left alone still (`content-anchor.ts`), so a row that itself changed grows
 * upward: its box moves while its text, the thing the person reads, stays. The text block is what is measured; the
 * row's box moved 22 px in the blip case of nightlies 41911961277 and 41936718739 and in 27 of 30 runs under load here;
 * the compensation log of those runs showed the three rows above the reader compensated exactly (22 px each).
 */
async function transcriptState(
	phone: Page,
	key?: string,
): Promise<{ kept: boolean; key: string | null; top: number | null }> {
	return phone
		.locator(".omp-transcript-scroll:visible")
		.first()
		.evaluate((node, wanted) => {
			const box = node.getBoundingClientRect();
			const rows = [...node.querySelectorAll<HTMLElement>("[data-row-key]")];
			const row = wanted
				? rows.find(el => el.dataset.rowKey === wanted)
				: rows.find(el => el.getBoundingClientRect().top >= box.top);
			const text = row?.querySelector<HTMLElement>(".omp-user-text, .markdown-body") ?? row;
			return {
				kept: Reflect.get(node, "__kept") === true,
				key: row?.dataset.rowKey ?? null,
				top: text ? text.getBoundingClientRect().top - box.top : null,
			};
		}, key);
}

/** Header controls and the work strip: nothing of the link's notice may lie over them. */
async function coveredControls(phone: Page): Promise<string[]> {
	return phone.evaluate(() => {
		const notice =
			document.getElementById("omp-web-connection") ??
			document.querySelector<HTMLElement>('.omp-titlebar-status[data-tone="offline"]');
		if (!notice) return [];
		const box = notice.getBoundingClientRect();
		const targets = [
			...document.querySelectorAll<HTMLElement>(
				"header.omp-titlebar button, header.omp-titlebar [data-device-chip], header.omp-titlebar [data-titlebar-session-name], [data-work-strip]",
			),
		].filter(el => !notice.contains(el) && el.getClientRects().length > 0);
		const hit: string[] = [];
		for (const el of targets) {
			const r = el.getBoundingClientRect();
			const overlap = Math.min(box.right, r.right) - Math.max(box.left, r.left);
			const overlapY = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
			if (overlap > 0.5 && overlapY > 0.5)
				hit.push(
					el.getAttribute("aria-label") ??
						el.getAttribute("data-work-strip") ??
						el.textContent?.trim() ??
						el.tagName,
				);
		}
		return hit;
	});
}

/** The page's visibility as the browser reports it (a phone switching apps), with its `visibilitychange`. */
function setVisibility(phone: Page, state: "hidden" | "visible") {
	return phone.evaluate(next => {
		Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
		Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	}, state);
}

async function capture(phone: Page, name: string): Promise<void> {
	const body = await phone.screenshot({ animations: "disabled", scale: "css" });
	await test.info().attach(`${name}.png`, { body, contentType: "image/png" });
	if (CAPTURES) {
		await fs.mkdir(CAPTURES, { recursive: true });
		await fs.writeFile(path.join(CAPTURES, `${name}.png`), body);
	}
}

async function fixture(phone: Page, tabId: string, line: string) {
	return phone.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		line,
	] as const);
}

for (const engine of ENGINES)
	test(`the phone (${engine.name}) reconnects quietly and fast, keeps its view and shows a drop only in the header`, async () => {
		test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
		test.setTimeout(300_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-reconnect-")));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
		);
		const tailscale = await fixtureTailscale(root, { backendState: "Running" });
		const record = path.join(root, "omp-received.jsonl");
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
			OMP_GUI_TEST_SESSION_FILES: "1",
			// A transcript to scroll up through.
			OMP_GUI_TEST_HISTORY: "120",
			OMP_GUI_TEST_RECORD: record,
			...tailscale.env,
		});
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		let app: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		const browser = await engine.type.launch();
		const numbers: Numbers[] = [];
		try {
			app = await electron.launch({
				args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
				env,
			});
			const desk = await app.firstWindow();
			await desk.waitForFunction(() => window.omp?.rpc != null);
			await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(tailscale).at(-1);
			if (!site) throw new Error("serve publishes no handler");
			proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
				plainCookie: engine.name === "webkit",
			});
			const link = proxy;
			const context = await browser.newContext({ ...engine.device, colorScheme: "light" });
			await context.addInitScript(watchLink);
			const phone = await context.newPage();
			await phone.goto(`${link.url}/`, { timeout: 60_000 });
			await phonePaired(phone);
			const tabId = (await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project))?.tabId;
			if (!tabId) throw new Error("no tab on the phone");
			await phone.reload({ timeout: 60_000 });
			await phonePaired(phone);
			const field = phone.locator("[data-composer-input]").first();
			await expect(field).toBeEditable({ timeout: 60_000 });
			await expect
				.poll(
					async () => (await phone.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === tabId)?.status,
					{
						timeout: 60_000,
					},
				)
				.toBe("ready");
			let loads = 0;
			phone.on("domcontentloaded", () => {
				loads++;
			});

			// A running session: a reply streams, with todos and subagents in the work strip.
			await field.fill("fixture stream");
			await phone.locator(".omp-composer-box").getByRole("button", { name: "Send", exact: true }).click();
			await expect(phone.getByText("Stream chunk 3.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
			expect((await fixture(phone, tabId, "fixture:todo")).success).toBe(true);
			expect((await fixture(phone, tabId, "fixture:subagents")).success).toBe(true);
			await expect(phone.locator("[data-work-strip] [data-work-chip]")).toBeVisible({ timeout: 20_000 });
			await expect(phone.getByText("Stream chunk 60.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
			// The person reads further up while it streams, and has a draft going.
			const scroller = phone.locator(".omp-transcript-scroll:visible").first();
			await scroller.evaluate(node => {
				node.scrollTop = Math.max(0, node.scrollHeight / 3);
				node.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
			});
			await phone.waitForTimeout(600);
			// Marked, so the checks can tell this scroller from a new one.
			await scroller.evaluate(node => Reflect.set(node, "__kept", true));
			const draft = "a draft typed while the link is shaky";
			await field.fill(draft);
			if (engine.name === "webkit") await capture(phone, "connected-light");

			const scenario = async (
				name: string,
				act: () => Promise<number>,
				options: { timeoutMs: number },
			): Promise<Numbers> => {
				const reading = await transcriptState(phone);
				const callsBefore = (await linkLog(phone)).calls.length;
				const start = await act();
				const hello = await helloAfter(phone, start - 1, options.timeoutMs);
				// Whatever catching up the page does, give it a moment to land.
				await phone.waitForTimeout(1500);
				const end = await now(phone);
				const log = await linkLog(phone);
				const notices = noticeTime(log, start, end);
				const state = await transcriptState(phone, reading.key ?? undefined);
				const result: Numbers = {
					scenario: name,
					reconnectMs: hello ? Math.round(hello.at - start) : null,
					resumed: hello?.resumed ?? null,
					noticeShownMs: notices.ms,
					notices: notices.kinds,
					calls: log.calls.slice(callsBefore).map(call => call.ch),
					bytesDownAfter: log.bytesDown
						.filter(entry => entry.at > (hello?.at ?? end))
						.reduce((n, e) => n + e.n, 0),
					draftKept: (await field.inputValue()) === draft,
					scrollMovedPx:
						state.top === null || reading.top === null ? null : Math.round(Math.abs(state.top - reading.top)),
					transcriptKept: state.kept,
					pageLoads: loads,
					// Close, ticket request, new socket and hello, from the drop (the 1080 to 1146 ms the blip took on hosted
					// WebKit, against 64 to 140 ms here, shows nowhere else).
					timeline: log.log
						.filter(entry => entry.at >= start - 1 && entry.at <= (hello?.at ?? end) + 50)
						.map(
							entry =>
								`+${Math.round(entry.at - start)}ms ${entry.what}${entry.detail === undefined ? "" : ` ${JSON.stringify(entry.detail)}`}`,
						),
				};
				numbers.push(result);
				return result;
			};

			// (1) A blip: the sockets are cut, the network is fine.
			const blip = await scenario(
				"blip",
				async () => {
					const at = await now(phone);
					link.dropSockets();
					return at;
				},
				{ timeoutMs: 20_000 },
			);
			// What the proxy saw of the requests around the blip (when each came and when the host answered), to set beside
			// the page's own timeline: the second ticket request took 970 ms of the 1080 to 1146 ms.
			const blipRequests = link.requestLog().split("\n").slice(-14).join(" | ");
			// (2) No network for 1.5 s (the browser knows: requests fail at once).
			const short = await scenario(
				"short-outage",
				async () => {
					const down = link.outage("refuse");
					await phone.waitForTimeout(1500);
					down.restore();
					return now(phone);
				},
				{ timeoutMs: 20_000 },
			);
			// (3) A dead route for 4 s: the socket goes silent and what the page sends is never answered, even after the
			// network is back. The page notices the silence on its own.
			const dead = await scenario(
				"dead-route",
				async () => {
					const down = link.outage("blackhole");
					await phone.waitForTimeout(4000);
					down.restore();
					return now(phone);
				},
				{ timeoutMs: 45_000 },
			);
			// (3b) A dead route for 12 s: the page gives the silent socket up inside it, and its ticket requests go
			// unanswered too; once the network is back it is connected within seconds.
			const deadLong = await scenario(
				"dead-route-long",
				async () => {
					const down = link.outage("blackhole");
					await phone.waitForTimeout(12_000);
					down.restore();
					return now(phone);
				},
				{ timeoutMs: 45_000 },
			);
			// (4) Back from the background over a link that died while the phone slept.
			const resume = await scenario(
				"background-resume",
				async () => {
					await setVisibility(phone, "hidden");
					const down = link.outage("blackhole");
					await phone.waitForTimeout(3000);
					down.restore();
					await setVisibility(phone, "visible");
					return now(phone);
				},
				{ timeoutMs: 45_000 },
			);
			// (5) A long outage: the header's status says so, over nothing, and goes when the link is back.
			let covered: string[] = [];
			const long = await scenario(
				"long-outage",
				async () => {
					const down = link.outage("refuse");
					await phone.waitForTimeout(6000);
					covered = await coveredControls(phone);
					if (engine.name === "webkit") await capture(phone, "long-drop-light");
					down.restore();
					return now(phone);
				},
				{ timeoutMs: 20_000 },
			);
			if (engine.name === "webkit") await capture(phone, "reconnected-light");
			if (CAPTURES && engine.name === "webkit") {
				// The phone's own appearance (a device pref), picked as a person does.
				const pickTheme = async (name: "light" | "dark") => {
					await phone.locator("header button:has(svg.lucide-menu)").click();
					await phone.locator('[data-destination="settings"]').click();
					await phone.locator('[data-settings-section="appearance"]').click();
					await phone.locator(`[data-theme-option="${name}"]`).scrollIntoViewIfNeeded();
					await phone.locator(`[data-theme-option="${name}"]`).click();
					await phone.getByRole("button", { name: "Back to session" }).click();
					await expect(field).toBeVisible();
					await phone.waitForTimeout(800);
				};
				await pickTheme("dark");
				await capture(phone, "connected-dark");
				const down = link.outage("refuse");
				await phone.waitForTimeout(4000);
				await capture(phone, "long-drop-dark");
				down.restore();
				await expect(phone.locator('.omp-titlebar-status[data-tone="offline"]')).toHaveCount(0, { timeout: 5000 });
				await capture(phone, "reconnected-dark");
				await pickTheme("light");
			}
			// (6) A message sent while the link is down arrives once the link is back, once.
			const sent = "fixture reply sent while offline";
			const queued = await scenario(
				"send-while-down",
				async () => {
					const down = link.outage("refuse");
					await phone.waitForTimeout(800);
					await field.fill(sent);
					await phone
						.locator(".omp-composer-box")
						.getByRole("button", { name: /^(Send|Queue|Steer)/ })
						.first()
						.click();
					await phone.waitForTimeout(1200);
					down.restore();
					return now(phone);
				},
				{ timeoutMs: 20_000 },
			);
			try {
				await expect
					.poll(
						async () =>
							(await fs.readFile(record, "utf8"))
								.split("\n")
								.filter(line => line.includes(sent) && /"type":"(prompt|steer|follow_up)"/.test(line)).length,
						{ timeout: 20_000 },
					)
					.toBe(1);
			} catch (error) {
				// The message that never reached omp: where it is (the page's outbox), what omp did receive, and the numbers so far.
				const outbox = await phone
					.evaluate(() => localStorage.getItem("omp.outbox.v1"))
					.catch((cause: unknown) => `unreadable: ${String(cause)}`);
				const received = (await fs.readFile(record, "utf8")).split("\n").slice(-12).join("\n");
				await test.info().attach("send-while-down.txt", {
					body: `outbox: ${outbox}\nomp received (last 12):\n${received}\nnumbers: ${JSON.stringify(numbers)}`,
				});
				throw error;
			}
			await phone.waitForTimeout(2000);
			expect(
				(await fs.readFile(record, "utf8"))
					.split("\n")
					.filter(line => line.includes(sent) && /"type":"(prompt|steer|follow_up)"/.test(line)).length,
			).toBe(1);

			const body = JSON.stringify({ engine: engine.name, numbers }, null, "\t");
			await test.info().attach("reconnect-numbers.json", { body, contentType: "application/json" });
			console.log(body);
			if (CAPTURES) await fs.writeFile(path.join(CAPTURES, `numbers-${engine.name}.json`), body);

			// The drops that heal within the grace show nothing and keep the view.
			for (const quiet of [blip, short, dead, resume, queued]) {
				expect.soft(quiet.noticeShownMs, `${quiet.scenario}: no notice`).toBe(0);
			}
			for (const any of [blip, short, dead, deadLong, resume, long]) {
				expect.soft(any.draftKept, `${any.scenario}: draft kept`).toBe(true);
				expect.soft(any.transcriptKept, `${any.scenario}: same transcript`).toBe(true);
				expect.soft(any.scrollMovedPx ?? Infinity, `${any.scenario}: reading position kept`).toBeLessThanOrEqual(4);
			}
			expect
				.soft(
					blip.reconnectMs ?? Infinity,
					`blip reconnects at once: ${blip.timeline.join(" | ")}\nproxy saw: ${blipRequests}`,
				)
				.toBeLessThan(1000);
			expect.soft(short.reconnectMs ?? Infinity, "back within a second of the network").toBeLessThan(1500);
			// Silence is asked about after 5 s and given up 2.5 s later: 4 s of it were inside the outage.
			expect.soft(dead.reconnectMs ?? Infinity, "a silent socket is given up within seconds").toBeLessThan(6000);
			// A ticket request sent on the dead route is given up after 4 s.
			expect.soft(deadLong.reconnectMs ?? Infinity, "back within seconds of the network").toBeLessThan(5500);
			expect.soft(resume.reconnectMs ?? Infinity, "back from the background quickly").toBeLessThan(4000);
			expect.soft(long.reconnectMs ?? Infinity, "back within a second of the network").toBeLessThan(1500);
			// A long drop shows the header's status only, never the full-width bar, and it covers nothing.
			expect.soft(long.notices).toEqual(["status"]);
			expect.soft(deadLong.notices).toEqual(["status"]);
			expect.soft(covered, "the status covers no header control").toEqual([]);
			expect.soft(long.noticeShownMs, "the status goes once the link is back").toBeLessThan(1500);
			expect(loads).toBe(0);
		} finally {
			await browser.close();
			await proxy?.close();
			if (app) await exitApp(app).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
		}
	});
