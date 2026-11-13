/**
 * Mobile web's brain on this computer: the switch, the Tailscale it needs, and the page's address (design §4.2).
 * The state machine is the core process's (`native/ompdesk/crates/core/src/tailscale/service.rs`: phases, the poll
 * tick's reading of `tailscale status` and `serve status`, enable, disable, install, sign-in, publish, confirm and
 * unpublish, the block retry, Funnel stopping the server); this file is its typed client.
 *
 * What stays here is what only main can do or must do synchronously. The core asks main (`mobileWeb.ask`) for the
 * prefs, the located CLI, the web server, the browser, the OS's settings and Tailscale's install, and main answers
 * from `deps` (`mobileWeb.answer`). Main keeps the chain: steps (enable, disable, start-app, login, retry, a poll
 * tick) run one at a time in a `SerialChain` with its bound, a stopped step is cancelled in the core (its questions
 * dropped, no call started, nothing written), and the poll's sleep is main's timer, armed with the delay the core
 * answered. The page's state is the core's with what main reads synchronously added: the setup item (`install`) and
 * the two prefs `allowedUsers` and `confirmNewDevices`.
 */

import { isIP } from "node:net";
import { z } from "zod";
import type { MobileWebRequest, MobileWebState } from "../../shared/mobile-web";
import type { SetupItemState, SetupState } from "../../shared/setup";
import { CORE_EXITED, CoreError, core } from "../core/process";
import { currentStepSignal, SerialChain, StepStalledError, throwIfStepStalled, trackEffect } from "../serial-chain";
import { type AppStart, mainEnv } from "./cli";
import type { LocatedTailscale } from "./locate";
import type { TailnetPeer } from "./whois";

/** The longest one serialized step (enable, login, a poll tick) runs. */
export const TAILSCALE_STEP_MAX_MS = 10 * 60_000;

/** Prefs (electron-store; a dotted key is a nested path). */
export const MOBILE_WEB_PREFS = {
	enabled: "mobileWeb.enabled",
	allowedUsers: "mobileWeb.allowedUsers",
	confirmNewDevices: "mobileWeb.confirmNewDevices",
	serve: "mobileWeb.serve",
	tailscaleBin: "mobileWeb.tailscaleBin",
} as const;

/**
 * The poll's delays and the times a phase waits on: the core decides with them (`service.rs`, the same values); they
 * are named here for the tests that move time.
 */
export const POLL_MS = 15_000;
/** While Settings watches, and while a step waits on the user or the OS. */
export const FAST_POLL_MS = 2_000;
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Tailscale that stays unreachable or `Starting` this long after it was started waits on the OS (approval). */
export const OS_APPROVAL_AFTER_MS = 20_000;
/** A refused publish (policy, HTTPS off) is tried again at most this often on its own. */
export const BLOCK_RETRY_MS = 60_000;
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

/** What the server needs of Mobile web (MobileWA's `WebServer`). */
export interface MobileWebServerPort {
	/** Listens on loopback; `port` is where. Resolves at once when it already does. */
	start(): Promise<{ port: number }>;
	stop(): Promise<void>;
	/**
	 * The address the page is published at (Host/Origin checks, `Secure` cookies) and the secret path of the serve
	 * handler's target: only a request that carries it came through serve, so only then are Tailscale's identity
	 * headers believed (web/serve-secret.ts).
	 */
	configure(address: { host: string; publicPort: number; secure: boolean; servePrefix: string }): void;
}

export interface MobileWebPrefsPort {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	delete(key: string): void;
}

/** The part of SetupService Mobile web uses (item `tailscale`). */
export interface MobileWebSetupPort {
	installForConnection(item: "tailscale"): Promise<SetupItemState>;
	cancel(): boolean;
}

export interface MobileWebServiceDeps {
	platform: "darwin" | "win32" | "other";
	prefs: MobileWebPrefsPort;
	server: MobileWebServerPort;
	/** The per-install secret path of the serve target (never stored in the prefs). */
	serveSecret: () => string;
	setup: MobileWebSetupPort;
	/** The Tailscale CLI of this machine (reads `mobileWeb.tailscaleBin` itself), or null. */
	locate: () => Promise<LocatedTailscale | null>;
	/** Start the Tailscale app (macOS `open -a Tailscale`, Windows `tailscale-ipn.exe`). */
	startApp: (located: LocatedTailscale) => Promise<AppStart>;
	openExternal: (url: string) => Promise<void>;
	openSystemSettings: () => Promise<void>;
	onState: (state: MobileWebState) => void;
	now?: () => number;
}

const RequestSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("enable") }),
	z.object({ action: z.literal("disable") }),
	z.object({ action: z.literal("install") }),
	z.object({ action: z.literal("cancel-install") }),
	z.object({ action: z.literal("start-app") }),
	z.object({ action: z.literal("login") }),
	z.object({ action: z.literal("retry") }),
	z.object({ action: z.literal("open-system-settings") }),
	z.object({ action: z.literal("set-allowed-users"), users: z.array(z.string().max(320)).max(100) }),
	z.object({ action: z.literal("set-confirm-new-devices"), on: z.boolean() }),
	z.object({ action: z.literal("watch"), on: z.boolean() }),
]);

/** A request from the page, checked. Throws for anything else. */
export function parseMobileWebRequest(value: unknown): MobileWebRequest {
	const parsed = RequestSchema.safeParse(value);
	if (!parsed.success) throw new Error("Invalid Mobile web request");
	return parsed.data;
}

/**
 * Trimmed, no empties, no repeats (case aside), in the order given. Main reads the allow list synchronously
 * (`allowedUsers()`); the core has the same rule for what it writes (`clean_logins`).
 */
export function cleanLogins(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const logins: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const login = value.trim();
		if (!login || seen.has(login.toLowerCase())) continue;
		seen.add(login.toLowerCase());
		logins.push(login);
	}
	return logins;
}

/** What the core decides of the page's state; main adds the rest (`install`, `allowedUsers`, `confirmNewDevices`). */
type CoreState = Omit<MobileWebState, "install" | "allowedUsers" | "confirmNewDevices">;

/** A state the core pushed or answered, with the delay to the next poll (none while off) and its order. */
interface Snapshot {
	state: CoreState;
	pollMs: number | null;
	seq: number;
}

/** A step's answer: `schedule` is whether the step ended where the poll's timer is armed again. */
interface Done extends Snapshot {
	schedule: boolean;
}

/** The core's question to main. */
interface Ask {
	service: number;
	/** The request the core asks for: a step stopped by its chain answers nothing. */
	token: number;
	call: number;
	op: string;
	[field: string]: unknown;
}

const OFF: CoreState = {
	enabled: false,
	phase: "off",
	url: null,
	host: null,
	port: null,
	user: null,
	tailscale: null,
	loginUrl: null,
	guideUrl: null,
	detail: null,
	funnelExposed: false,
	published: false,
	phones: [],
};

/** Room past a step's bound: the core answers a stopped step's cancel, and the round trip. */
const STEP_SLACK_MS = 60_000;

const services = new Map<number, MobileWebService>();
let nextService = 0;
let nextToken = 0;
let routed = false;

/** The core's questions, states and poll requests reach the service they name. */
function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("mobileWeb.ask", (data, _bin, generation) => {
		const ask = data as Ask;
		const service = services.get(ask.service);
		if (service) service.answerAsk(ask, generation);
		else
			void core()
				.call("mobileWeb.answer", { call: ask.call, ok: false, message: "cancelled" }, { generation })
				.catch(() => undefined);
	});
	process.on("mobileWeb.state", data => {
		const event = data as Snapshot & { service: number };
		services.get(event.service)?.took(event);
	});
	// A core that ended took every service's state with it: each asks for its state again from the prefs.
	process.on(CORE_EXITED, () => {
		for (const service of services.values()) service.coreLost();
	});
	process.on("mobileWeb.refresh", data => {
		const { service } = data as { service: number };
		services
			.get(service)
			?.refresh()
			.catch(error =>
				console.warn(`[mobile-web] poll failed: ${error instanceof Error ? error.message : String(error)}`),
			);
	});
}

export class MobileWebService {
	readonly #deps: MobileWebServiceDeps;
	readonly #id = ++nextService;
	#core: CoreState = OFF;
	#seq = 0;
	#pollMs: number | null = null;
	#setupItem: SetupItemState | null = null;
	#disposed = false;
	/** The core knows this service: a quit with nothing asked of the core does not start it. */
	#used = false;
	#timer: NodeJS.Timeout | null = null;
	/** The token of each request in flight, with the signal of the chain step it was made in. */
	readonly #tokens = new Map<number, AbortSignal | undefined>();
	/** One step at a time; a step past `TAILSCALE_STEP_MAX_MS` is stopped and the next runs (a poll never waits behind a hung CLI). */
	#chain = new SerialChain({ name: "tailscale", maxStepMs: TAILSCALE_STEP_MAX_MS });
	#lastEmitted = "";

	constructor(deps: MobileWebServiceDeps) {
		this.#deps = deps;
		services.set(this.#id, this);
		route();
	}

	state(): MobileWebState {
		const core = this.#core;
		const item = this.#setupItem;
		const install = core.phase === "not-installed" || core.phase === "installing";
		return {
			...core,
			allowedUsers: this.allowedUsers(),
			confirmNewDevices: this.confirmNewDevices(),
			install: install
				? {
						progress: item?.phase === "running" ? item.progress : null,
						failure: item?.phase === "failed" ? item.failure : null,
						manualUrl: item?.manualUrl || TAILSCALE_DOWNLOAD_URL,
					}
				: null,
		};
	}

	/**
	 * Logins allowed to reach this computer, for Mobile web and for other OMPdesk computers alike: the pref, or this
	 * computer's own while it is unset. Never an untrusted shape.
	 */
	allowedUsers(): string[] {
		const stored = this.#deps.prefs.get(MOBILE_WEB_PREFS.allowedUsers);
		const users = Array.isArray(stored) ? cleanLogins(stored) : [];
		if (users.length === 0 && this.#core.user) return [this.#core.user];
		return users;
	}

	/** A new device waits for the user's approval on this computer. Off unless the user turned it on. */
	confirmNewDevices(): boolean {
		return this.#deps.prefs.get(MOBILE_WEB_PREFS.confirmNewDevices) === true;
	}

	/** This computer's tailnet login as computer sharing read it (Mobile web may be off): allowed by default. */
	adoptLogin(login: string): void {
		if (this.#core.user === login) return;
		this.#core = { ...this.#core, user: login };
		this.#deliver();
		void this.#call("mobileWeb.adopt", { login }).catch(() => undefined);
	}

	/** At launch: pick the switch up where the last run left it. */
	async start(): Promise<void> {
		const started = await this.#call<Snapshot & { started: boolean }>("mobileWeb.start", {});
		this.took(started);
		if (started.started) await this.refresh();
	}

	/** Setup's state changed (machine setup pushes it); only the `tailscale` item matters. */
	onSetupState(state: SetupState): void {
		this.#setupItem = state.items.find(item => item.id === "tailscale") ?? null;
		this.#deliver();
	}

	async request(value: unknown): Promise<MobileWebState> {
		const request = parseMobileWebRequest(value);
		switch (request.action) {
			case "enable":
			case "disable":
			case "start-app":
			case "login":
			case "retry": {
				const { action } = request;
				const done = await this.#chain.run(() => this.#step(action));
				if (done.schedule) this.#schedule();
				break;
			}
			default: {
				this.took(await this.#call<Snapshot>("mobileWeb.act", { request }));
				if (request.action === "watch") {
					if (request.on && this.#core.enabled) void this.refresh();
					else this.#schedule();
				}
			}
		}
		return this.state();
	}

	/**
	 * Which node and user a tailnet address belongs to (`tailscale whois`), or null when it is no address, the CLI is
	 * not there or does not know it. Read-only and not queued behind the poll: a visit waits on it.
	 */
	async whois(address: string): Promise<TailnetPeer | null> {
		if (isIP(address) === 0) return null;
		try {
			return await this.#call<TailnetPeer | null>("mobileWeb.whois", { address });
		} catch (error) {
			// A core that cannot answer reads as a CLI that does not know the address.
			if (error instanceof CoreError) return null;
			throw error;
		}
	}

	/** One poll tick now, then the next is scheduled. */
	async refresh(): Promise<void> {
		// A poll that was stopped for running past its bound is logged (chain-stall); the next one runs on the timer.
		await this.#chain
			.run(() => this.#step("tick"))
			.catch(error => {
				if (!(error instanceof StepStalledError)) throw error;
			});
		this.#schedule();
	}

	/** App quit: stop polling. The serve handler stays in the daemon, as the design says. */
	dispose(): void {
		this.#disposed = true;
		this.#clearTimer();
		// The core stops the page's server it started; what it asks main answers before this service is forgotten.
		if (this.#used)
			void this.#call("mobileWeb.dispose", {})
				.then(undefined, () => undefined)
				.finally(() => services.delete(this.#id));
		else services.delete(this.#id);
	}

	// ── what the core says ───────────────────────────────────────────────────

	/** The core ended: its state of this service is gone, and the switch is read again from the prefs. */
	coreLost(): void {
		if (this.#disposed || !this.#used) return;
		this.#seq = 0;
		this.#clearTimer();
		this.start().catch(error =>
			console.warn(
				`[mobile-web] restart after the core ended failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	/** A state from the core, unless a newer one came. */
	took(snapshot: Snapshot): void {
		if (snapshot.seq > this.#seq) {
			this.#seq = snapshot.seq;
			this.#core = snapshot.state;
			this.#pollMs = snapshot.pollMs;
			// A switch that went off stops the poll at once.
			if (this.#pollMs === null) this.#clearTimer();
		}
		this.#deliver();
	}

	/** The page's state, pushed whole when it changed. */
	#deliver(): void {
		const state = this.state();
		const text = JSON.stringify(state);
		if (text === this.#lastEmitted) return;
		this.#lastEmitted = text;
		this.#deps.onState(state);
	}

	/**
	 * Answers the core's question from `deps`; a question of a step that was stopped is not asked. The answer goes only to
	 * the core of `generation` that asked: the next core numbers its questions from 1 again.
	 */
	answerAsk(ask: Ask, generation: number): void {
		const reply = (body: { ok: true; result: unknown } | { ok: false; message: string }) =>
			void core()
				.call("mobileWeb.answer", { call: ask.call, ...body }, { generation })
				.catch(() => undefined);
		if (this.#tokens.get(ask.token)?.aborted) {
			reply({ ok: false, message: "cancelled" });
			return;
		}
		// The call to `deps` is made at once, in the order the core asked.
		let done: Promise<unknown>;
		try {
			done = Promise.resolve(this.#perform(ask));
		} catch (error) {
			done = Promise.reject(error);
		}
		done.then(
			result => reply({ ok: true, result: result ?? null }),
			error => reply({ ok: false, message: error instanceof Error ? error.message : String(error) }),
		);
	}

	#perform(ask: Ask): unknown {
		const deps = this.#deps;
		switch (ask.op) {
			case "prefGet":
				return { value: deps.prefs.get(ask.key as string) };
			case "prefSet":
				deps.prefs.set(ask.key as string, ask.value);
				return null;
			case "prefDelete":
				deps.prefs.delete(ask.key as string);
				return null;
			case "locate":
				return deps.locate().then(located => (located ? { located, env: mainEnv(located.env) } : null));
			case "startApp":
				return deps.startApp(ask.located as LocatedTailscale);
			case "openExternal":
				return deps.openExternal(ask.url as string);
			case "openSystemSettings":
				return deps.openSystemSettings();
			case "serverStart":
				return deps.server.start();
			case "serverStop":
				return deps.server.stop();
			case "serverConfigure":
				deps.server.configure({
					host: ask.host as string,
					publicPort: ask.publicPort as number,
					secure: ask.secure as boolean,
					servePrefix: ask.servePrefix as string,
				});
				return null;
			case "serveSecret":
				return deps.serveSecret();
			case "install":
				return deps.setup.installForConnection("tailscale").then(item => {
					this.#setupItem = item ?? null;
					this.#deliver();
					return item ?? null;
				});
			case "cancelInstall":
				return deps.setup.cancel();
			default:
				throw new Error(`Unknown question "${ask.op}"`);
		}
	}

	// ── requests to the core ─────────────────────────────────────────────────

	/** One serialized step, ended: what the core made of it. */
	async #step(action: string): Promise<Done> {
		const done = await this.#call<Done>("mobileWeb.step", { action }, TAILSCALE_STEP_MAX_MS + STEP_SLACK_MS);
		this.took(done);
		return done;
	}

	/**
	 * A request to the core, held to the chain step it is made in: it never starts in a stopped step, a step stopped
	 * while it runs has it cancelled (the core drops what it asks and starts nothing more), the chain's next step waits
	 * until the core is done with it, and the stopped step goes no further. Outside any step it is a plain request.
	 */
	async #call<T>(method: string, params: object, timeoutMs?: number): Promise<T> {
		throwIfStepStalled();
		this.#used = true;
		const token = ++nextToken;
		const signal = currentStepSignal();
		this.#tokens.set(token, signal);
		const ended = Promise.withResolvers<void>();
		void trackEffect(method, ended.promise);
		const common = {
			service: this.#id,
			platform: this.#deps.platform,
			token,
			setupItem: this.#setupItem,
			...(this.#deps.now ? { now: this.#deps.now() } : {}),
		};
		try {
			const answer = await core().call<T>(
				method,
				{ ...common, ...params },
				{ ...(timeoutMs ? { timeoutMs } : {}), signal, onEnded: ended.resolve },
			);
			throwIfStepStalled();
			return answer.result;
		} catch (error) {
			throwIfStepStalled();
			throw error;
		} finally {
			this.#tokens.delete(token);
		}
	}

	// ── the poll's timer ─────────────────────────────────────────────────────

	#clearTimer(): void {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	#schedule(): void {
		this.#clearTimer();
		if (this.#disposed || this.#pollMs === null) return;
		this.#timer = setTimeout(() => void this.refresh(), this.#pollMs);
		this.#timer.unref();
	}
}
