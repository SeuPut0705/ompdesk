/**
 * Evidence for the agent's click that never navigates (issue #21): the second drive of preview-agent-remote.e2e.ts,
 * after Take over closed the agent's first connection to the page, has twice timed out in `waitForNavigation` on
 * hosted runners. A failure carries what separates the three causes:
 *
 * - the click landed but nothing navigated: the page's own pointer/click events reach `#next`, `Input.dispatchMouseEvent`
 *   was answered, and no `Page.frameRequestedNavigation`/`frameNavigated` follows (or main logs `did-fail-load`);
 * - the click missed: `elementFromPoint` at `#next`'s centre is not `#next`, or the click point lies outside the
 *   viewport, or the viewport differs from the one before the click;
 * - the input never arrived: the page's event log is empty although the mouse commands were sent and answered.
 *
 * A `frameNavigated` with no matching `load` lifecycle event is a fourth: the page navigated and puppeteer never heard.
 * Everything is read through the test's own connections (the agent's puppeteer session, the page's own document, the
 * Electron main process of the computer that owns the page), so no product hook is needed. The log goes into the
 * failure's message (nightly logs and the flake-probe summary print it) and the Playwright report as an attachment.
 */
import type { ElectronApplication, Page } from "@playwright/test";
import { test } from "@playwright/test";
import type { PuppeteerPage } from "./preview-agent-fixture";

/** The slice of puppeteer-core's CDPSession the probe uses (`CdpPage._client()`, internal to the installed puppeteer). */
interface ProbeClient {
	send?: (method: string, params?: unknown, options?: unknown) => Promise<unknown>;
	on(event: string, handler: (params: unknown) => void): unknown;
	off(event: string, handler: (params: unknown) => void): unknown;
}

/** Commands worth a line: input, emulation, navigation and the geometry puppeteer's click reads. */
const LOGGED_COMMANDS =
	/^(Input\.|Emulation\.|Page\.(navigate|reload|stopLoading|bringToFront|getLayoutMetrics)|DOM\.(scrollIntoViewIfNeeded|getContentQuads|getBoxModel))/;
const LOGGED_EVENTS = [
	"Page.frameRequestedNavigation",
	"Page.frameStartedNavigating",
	"Page.frameNavigated",
	"Page.frameStartedLoading",
	"Page.frameStoppedLoading",
	"Page.navigatedWithinDocument",
	"Page.domContentEventFired",
	"Page.loadEventFired",
	"Page.lifecycleEvent",
	"Page.frameDetached",
	"Inspector.targetCrashed",
] as const;

const FAILURE_TEXT_LIMIT = 10000;
const STATE_TIMEOUT_MS = 5000;

const short = (value: unknown, limit = 400): string => {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** What the page itself sees around `#next`, read by one `Runtime.evaluate`. */
function readPage() {
	const next = document.querySelector("#next");
	const rect = next?.getBoundingClientRect();
	const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
	const viewport = window.visualViewport;
	let stored: unknown[] = [];
	try {
		stored = JSON.parse(sessionStorage.getItem("clickProbe") ?? "[]") as unknown[];
	} catch {
		stored = [];
	}
	return {
		href: location.href,
		ready: document.readyState,
		visibility: document.visibilityState,
		focused: document.hasFocus(),
		inner: [innerWidth, innerHeight],
		outer: [outerWidth, outerHeight],
		devicePixelRatio,
		visual: viewport
			? [viewport.width, viewport.height, viewport.scale, viewport.offsetLeft, viewport.offsetTop]
			: null,
		scroll: [scrollX, scrollY],
		next: rect ? [rect.x, rect.y, rect.width, rect.height] : null,
		hit: hit ? `${hit.tagName}#${hit.id}` : null,
		events: stored,
	};
}

/** The page's own pointer and click events, kept in sessionStorage so the next document of the origin still has them. */
function armPageEvents() {
	const record = (event: Event) => {
		const mouse = event as MouseEvent;
		const target =
			event.target instanceof Element ? `${event.target.tagName}#${event.target.id}` : String(event.target);
		let stored: unknown[] = [];
		try {
			stored = JSON.parse(sessionStorage.getItem("clickProbe") ?? "[]") as unknown[];
			stored.push([
				Math.round(performance.now()),
				event.type,
				target,
				mouse.clientX,
				mouse.clientY,
				event.isTrusted,
			]);
			sessionStorage.setItem("clickProbe", JSON.stringify(stored.slice(-40)));
		} catch {
			// sessionStorage refused: the log in the page is the CDP side's alone.
		}
	};
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "beforeunload", "pagehide"]) {
		addEventListener(type, record, { capture: true });
	}
}

/** Main-side listeners on the pages of `origin`, once per page; the log is `globalThis.clickProbe` of the main process. */
function armMain(electron: { webContents: { getAllWebContents(): unknown[] } }, origin: string) {
	const scope = globalThis as unknown as { clickProbe?: string[]; clickProbeArmed?: WeakSet<object> };
	scope.clickProbe ??= [];
	scope.clickProbeArmed ??= new WeakSet();
	const log = scope.clickProbe;
	const armed = scope.clickProbeArmed;
	const stamp = () => Date.now() % 1_000_000;
	interface Contents {
		getURL(): string;
		on(event: string, handler: (...args: unknown[]) => void): void;
		getZoomFactor(): number;
		getOwnerBrowserWindow?: () => {
			on(event: string, handler: () => void): void;
			getContentSize(): number[];
		} | null;
	}
	for (const candidate of electron.webContents.getAllWebContents()) {
		const contents = candidate as Contents;
		if (!contents.getURL().startsWith(origin) || armed.has(contents)) continue;
		armed.add(contents);
		const owner = contents.getOwnerBrowserWindow?.() ?? null;
		owner?.on("resize", () => {
			log.push(
				`${stamp()} main window resize content=${owner.getContentSize().join("x")} zoom=${contents.getZoomFactor()}`,
			);
		});
		for (const event of [
			"did-start-loading",
			"did-stop-loading",
			"did-start-navigation",
			"did-navigate",
			"did-fail-load",
			"will-frame-navigate",
			"render-process-gone",
			"unresponsive",
			"responsive",
			"focus",
			"blur",
		]) {
			contents.on(event, (...args: unknown[]) => {
				const detail = args.map(arg => {
					if (arg && typeof arg === "object" && "url" in arg) {
						const { url, isMainFrame, isSameDocument } = arg as Record<string, unknown>;
						return `${String(url)} main=${String(isMainFrame)} same=${String(isSameDocument)}`;
					}
					return typeof arg === "object" ? "" : String(arg);
				});
				log.push(`${stamp()} main ${event} ${detail.filter(Boolean).join(" ")}`.trim());
			});
		}
	}
}

/** The phone page's own layout commands to the host (what sizes the streamed page), stamped on the main log's clock. */
function armLayoutLog() {
	const scope = window as unknown as {
		clickProbeLayout?: string[];
		omp: { preview: { command(request: { action: string }): Promise<unknown> } };
	};
	if (scope.clickProbeLayout) return;
	scope.clickProbeLayout = [];
	const log = scope.clickProbeLayout;
	const original = scope.omp.preview.command;
	scope.omp.preview.command = request => {
		if (request.action === "layout") log.push(`${Date.now() % 1_000_000} ${JSON.stringify(request)}`);
		return original(request);
	};
}

/** The layout commands logged so far. */
function readLayoutLog() {
	return (window as unknown as { clickProbeLayout?: string[] }).clickProbeLayout ?? [];
}

/** The state of the page's `webContents` in its Electron main process. */
function readMain(electron: { webContents: { getAllWebContents(): unknown[] } }, origin: string) {
	interface Contents {
		getURL(): string;
		isLoading(): boolean;
		isFocused(): boolean;
		isDestroyed(): boolean;
		getZoomFactor(): number;
		debugger: { isAttached(): boolean };
		getOwnerBrowserWindow?: () => { getBounds(): unknown; isVisible(): boolean; isFocused(): boolean } | null;
	}
	const scope = globalThis as unknown as { clickProbe?: string[] };
	const pages = (electron.webContents.getAllWebContents() as Contents[])
		.filter(contents => !contents.isDestroyed() && contents.getURL().startsWith(origin))
		.map(contents => {
			const owner = contents.getOwnerBrowserWindow?.() ?? null;
			return {
				url: contents.getURL(),
				loading: contents.isLoading(),
				focused: contents.isFocused(),
				zoom: contents.getZoomFactor(),
				debuggerAttached: contents.debugger.isAttached(),
				window: owner
					? { bounds: owner.getBounds(), visible: owner.isVisible(), focused: owner.isFocused() }
					: null,
			};
		});
	return { pages, events: (scope.clickProbe ?? []).slice(-16) };
}

/** What one agent click on `#next` did, from the agent's connection, the page and the main process that owns it. */
export class ClickProbe {
	readonly #lines: string[] = [];
	readonly #origin: string;
	readonly #app: ElectronApplication;
	readonly #page: PuppeteerPage;
	readonly #phone: Page | null;
	readonly #client: ProbeClient | null;
	readonly #began = Date.now();
	readonly #listeners: [string, (params: unknown) => void][] = [];
	#armedSend: ProbeClient["send"] | null = null;

	private constructor(page: PuppeteerPage, app: ElectronApplication, origin: string, phone: Page | null) {
		this.#page = page;
		this.#app = app;
		this.#origin = origin;
		this.#phone = phone;
		// `_client()` is puppeteer's own accessor of the page's CDP session; there is no public one for it.
		const internal = page as unknown as { _client?: () => ProbeClient };
		this.#client = internal._client?.() ?? null;
	}

	/**
	 * Start before the agent's `goto`, so the navigation that led to the click is in the log. `phone` is the paired
	 * phone's page when the panel is a streamed one: its layout commands size the host's offscreen window.
	 */
	static async start(
		page: PuppeteerPage,
		app: ElectronApplication,
		site: string,
		phone: Page | null,
	): Promise<ClickProbe> {
		const probe = new ClickProbe(page, app, new URL(site).origin, phone);
		probe.#hookClient();
		await probe.#hookMain();
		if (phone) await probe.#within("layout log", () => phone.evaluate(armLayoutLog));
		return probe;
	}

	#note(text: string) {
		this.#lines.push(`${String(Date.now() - this.#began).padStart(6)} ms  ${text}`);
	}

	#hookClient() {
		const client = this.#client;
		if (!client?.send) {
			this.#note("no puppeteer page client: the CDP side is not logged");
			return;
		}
		const original = client.send;
		this.#armedSend = original;
		client.send = async (method, params, options) => {
			const logged = LOGGED_COMMANDS.test(method);
			if (logged) this.#note(`send ${method} ${short(params)}`);
			try {
				const result = await original.call(client, method, params, options);
				if (logged) this.#note(`done ${method} ${short(result, 240)}`);
				return result;
			} catch (error) {
				if (logged) this.#note(`fail ${method} ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		};
		for (const event of LOGGED_EVENTS) {
			const handler = (params: unknown) => this.#note(`event ${event} ${short(params, 240)}`);
			client.on(event, handler);
			this.#listeners.push([event, handler]);
		}
	}

	async #hookMain() {
		try {
			await this.#app.evaluate(armMain, this.#origin);
		} catch (error) {
			this.#note(`main-process log not armed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #within<T>(label: string, read: () => Promise<T>): Promise<T | string> {
		const timeout = Promise.withResolvers<string>();
		const timer = setTimeout(() => timeout.resolve(`no answer in ${STATE_TIMEOUT_MS} ms`), STATE_TIMEOUT_MS);
		try {
			return await Promise.race([read(), timeout.promise]);
		} catch (error) {
			return `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			clearTimeout(timer);
		}
	}

	async #snapshot(label: string) {
		const page = await this.#within("page", () => this.#page.evaluate(readPage));
		this.#note(`${label} page ${short(page, 900)}`);
		const main = await this.#within("main", () => this.#app.evaluate(readMain, this.#origin));
		this.#note(`${label} main ${short(main, 2400)}`);
		const phone = this.#phone;
		if (phone) {
			const layouts = await this.#within("phone layouts", () => phone.evaluate(readLayoutLog));
			this.#note(
				`${label} phone layout commands ${short(Array.isArray(layouts) ? layouts.slice(-12) : layouts, 2400)}`,
			);
		}
	}

	/** After the agent's `goto` and before its click: the page's event log starts and its state is recorded. */
	async beforeClick() {
		await this.#within("arm", () => this.#page.evaluate(armPageEvents));
		await this.#snapshot("before click");
	}

	/** The click's own failure: the state after it, attached to the report and carried by the error. */
	async failed(error: unknown): Promise<Error> {
		await this.#snapshot("after failure");
		const text = this.#lines.join("\n");
		await test.info().attach("click-probe", { body: text, contentType: "text/plain" });
		const original = error instanceof Error ? error.message : String(error);
		const body = text.length > FAILURE_TEXT_LIMIT ? `…${text.slice(-FAILURE_TEXT_LIMIT)}` : text;
		return new Error(`${original}\n--- agent click probe (issue #21) ---\n${body}`, { cause: error });
	}

	stop() {
		const client = this.#client;
		if (!client) return;
		for (const [event, handler] of this.#listeners) client.off(event, handler);
		this.#listeners.length = 0;
		if (this.#armedSend) delete client.send;
	}
}
