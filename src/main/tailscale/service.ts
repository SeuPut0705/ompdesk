/**
 * Mobile web's brain on this computer: the switch, the Tailscale it needs, and the page's address (design §4.2).
 *
 * Every poll tick looks at the world again (`tailscale status --json`, `serve status --json`) and derives the phase
 * from it, so a Tailscale that goes away, signs out or loses HTTPS moves `ready` back by itself; the user's
 * clicks (`MobileWebRequest`) only start a step (install, start the app, sign in) or flip the switch. Everything
 * runs one at a time, and every change is pushed as the whole `MobileWebState`.
 *
 * The page's server is started once the tailnet is ready to publish it (its address needs this machine's MagicDNS
 * name) and stopped when the switch goes off or Funnel exposes our port. The `tailscale serve` handler stays in
 * the daemon when the app quits (it is restored on the next launch); turning the switch off removes our handler
 * and nothing else (serve.ts).
 */

import { isIP } from "node:net";
import { z } from "zod";
import type { MobileWebPhase, MobileWebRequest, MobileWebState, MobileWebTailscale } from "../../shared/mobile-web";
import type { SetupItemState, SetupState } from "../../shared/setup";
import { compareVersions } from "../../shared/version";
import { fencedCall, SerialChain, StepStalledError, throwIfStepStalled } from "../serial-chain";
import {
	authUrlFromUpJson,
	controlHostFromPrefs,
	type ExecResult,
	extractLoginUrl,
	firstLine,
	loginUrlAllowed,
	TailscaleCli,
	type TailscaleExecutor,
} from "./cli";
import type { LocatedTailscale } from "./locate";
import {
	funnelOn,
	handlerIsOurs,
	ownProxy,
	parseServeStatus,
	planPublish,
	readServeRecord,
	type ServeRecord,
	sameServeConfig,
	withoutPort,
} from "./serve";
import {
	ADMIN_DNS_URL,
	ADMIN_MACHINES_URL,
	httpsProblem,
	MIN_TAILSCALE_VERSION,
	parseStatus,
	type TailscaleStatus,
} from "./status";
import { parseWhois, type TailnetPeer } from "./whois";

/**
 * `deps` with every call that reaches outside (the CLI's executor, the locate, the server, the app, the browser, the
 * install) fenced to its chain step: a step that was stopped for running past its bound can still resume when
 * one of them settles, and must neither start the next call nor go on to write state the next step owns. The fence
 * throws before a call starts and as soon as it returns; outside any step it does nothing.
 */
function fenced(deps: MobileWebServiceDeps): MobileWebServiceDeps {
	const guard = fencedCall;
	return {
		...deps,
		locate: guard(() => deps.locate()),
		exec: guard((file, args, options) => deps.exec(file, args, options)),
		startApp: guard(located => deps.startApp(located)),
		openExternal: guard(url => deps.openExternal(url)),
		openSystemSettings: guard(() => deps.openSystemSettings()),
		server: {
			...deps.server,
			start: guard(() => deps.server.start()),
			stop: guard(() => deps.server.stop()),
			configure: (...args) => {
				throwIfStepStalled();
				return deps.server.configure(...args);
			},
		},
		setup: { ...deps.setup, installForConnection: guard(item => deps.setup.installForConnection(item)) },
	};
}

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
	exec: TailscaleExecutor;
	/** Start the Tailscale app (macOS `open -a Tailscale`, Windows `tailscale-ipn.exe`). */
	startApp: (located: LocatedTailscale) => Promise<ExecResult>;
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

/** Trimmed, no empties, no repeats (case aside), in the order given. */
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

/** What turning our handler off did. `failed` keeps the record: the handler may still be there. */
type Unpublished =
	| { kind: "none" }
	| { kind: "removed" }
	| { kind: "record-dropped" }
	| { kind: "failed"; detail: string };

export class MobileWebService {
	readonly #deps: MobileWebServiceDeps;
	#enabled = false;
	#disposed = false;
	#phase: MobileWebPhase = "off";
	#cli: TailscaleCli | null = null;
	#status: TailscaleStatus | null = null;
	#version: string | null = null;
	#updateAvailable = false;
	#user: string | null = null;
	#phones: string[] = [];
	#detail: string | null = null;
	#loginUrl: string | null = null;
	#guideUrl: string | null = null;
	/** The `login.tailscale.com` page a refused `serve` named ("enable HTTPS"). */
	#serveGuide: string | null = null;
	#controlHost: string | null = null;
	#funnelExposed = false;
	#published = false;
	#host: string | null = null;
	#port: number | null = null;
	#serverUp = false;
	#localPort: number | null = null;
	#loginStartedAt: number | null = null;
	#appStartedAt: number | null = null;
	#unreachableSince: number | null = null;
	/** `up` ran for a stopped Tailscale in this round (enable, retry, start-app, login). */
	#upTried = false;
	#upError: string | null = null;
	/** Start the app once the install that was just done finished. */
	#autoStartApp = false;
	/** Why the last "start the app" failed. */
	#launchError: string | null = null;
	#installRequested = false;
	#setupItem: SetupItemState | null = null;
	#blocked: { phase: "serve-blocked" | "https-disabled"; detail: string; at: number } | null = null;
	#watching = false;
	#timer: NodeJS.Timeout | null = null;
	/** One step at a time; a step past `TAILSCALE_STEP_MAX_MS` is stopped and the next runs (a poll never waits behind a hung CLI). */
	#chain = new SerialChain({ name: "tailscale", maxStepMs: TAILSCALE_STEP_MAX_MS });
	#lastEmitted = "";

	constructor(deps: MobileWebServiceDeps) {
		this.#deps = fenced(deps);
	}

	#now(): number {
		return (this.#deps.now ?? Date.now)();
	}

	state(): MobileWebState {
		const on = this.#enabled;
		const install = this.#phase === "not-installed" || this.#phase === "installing";
		const item = this.#setupItem;
		const tailscale: MobileWebTailscale | null =
			on && this.#cli
				? {
						variant: this.#cli.located.variant,
						path: this.#cli.located.path,
						version: this.#version,
						updateAvailable: this.#updateAvailable,
					}
				: null;
		return {
			enabled: on,
			phase: this.#phase,
			url: this.#phase === "ready" && this.#host && this.#port ? `https://${this.#host}:${this.#port}` : null,
			host: on ? this.#host : null,
			port: on ? this.#port : null,
			user: this.#user,
			allowedUsers: this.allowedUsers(),
			confirmNewDevices: this.confirmNewDevices(),
			tailscale,
			install: install
				? {
						progress: item?.phase === "running" ? item.progress : null,
						failure: item?.phase === "failed" ? item.failure : null,
						manualUrl: item?.manualUrl || TAILSCALE_DOWNLOAD_URL,
					}
				: null,
			loginUrl: this.#phase === "needs-login" || this.#phase === "logging-in" ? this.#loginUrl : null,
			guideUrl: this.#guideUrl,
			detail: this.#detail,
			funnelExposed: this.#funnelExposed,
			published: this.#published,
			phones: this.#phones,
		};
	}

	/**
	 * Logins allowed to reach this computer, for Mobile web and for other OMPdesk computers alike: the pref, or this
	 * computer's own while it is unset. Never an untrusted shape.
	 */
	allowedUsers(): string[] {
		const stored = this.#deps.prefs.get(MOBILE_WEB_PREFS.allowedUsers);
		const users = Array.isArray(stored) ? cleanLogins(stored) : [];
		if (users.length === 0 && this.#user) return [this.#user];
		return users;
	}

	/** This computer's tailnet login as computer sharing read it (Mobile web may be off): allowed by default. */
	adoptLogin(login: string): void {
		if (this.#user === login) return;
		this.#adoptUser(login);
		this.#emit();
	}

	/** At launch: pick the switch up where the last run left it. */
	async start(): Promise<void> {
		if (this.#deps.prefs.get(MOBILE_WEB_PREFS.enabled) !== true || this.#deps.platform === "other") return;
		this.#enabled = true;
		this.#phase = "detecting";
		this.#emit();
		await this.refresh();
	}

	/** Setup's state changed (machine setup pushes it); only the `tailscale` item matters. */
	onSetupState(state: SetupState): void {
		this.#setupItem = state.items.find(item => item.id === "tailscale") ?? null;
		this.#emit();
	}

	async request(value: unknown): Promise<MobileWebState> {
		const request = parseMobileWebRequest(value);
		switch (request.action) {
			case "enable":
				await this.#serial(() => this.#enable());
				break;
			case "disable":
				await this.#serial(() => this.#disable());
				break;
			case "install":
				this.#install();
				break;
			case "cancel-install":
				this.#deps.setup.cancel();
				break;
			case "start-app":
				await this.#serial(() => this.#startApp());
				break;
			case "login":
				await this.#serial(() => this.#login());
				break;
			case "retry":
				await this.#serial(() => this.#retry());
				break;
			case "open-system-settings":
				await this.#deps.openSystemSettings();
				break;
			case "set-allowed-users":
				this.#setAllowedUsers(request.users);
				break;
			case "set-confirm-new-devices":
				this.#deps.prefs.set(MOBILE_WEB_PREFS.confirmNewDevices, request.on);
				this.#emit();
				break;
			case "watch":
				this.#watching = request.on;
				if (request.on && this.#enabled) void this.refresh();
				else this.#schedule();
				break;
		}
		return this.state();
	}

	/** A new device waits for the user's approval on this computer. Off unless the user turned it on. */
	confirmNewDevices(): boolean {
		return this.#deps.prefs.get(MOBILE_WEB_PREFS.confirmNewDevices) === true;
	}

	/**
	 * Which node and user a tailnet address belongs to (`tailscale whois`), or null when it is no address, the CLI is
	 * not there or does not know it. Read-only and not queued behind the poll: a visit waits on it.
	 */
	async whois(address: string): Promise<TailnetPeer | null> {
		if (!this.#enabled || isIP(address) === 0) return null;
		const cli = await this.#cliOrNull();
		if (!cli) return null;
		const result = await cli.whois(address);
		return result.code === 0 ? parseWhois(result.stdout) : null;
	}

	/** One poll tick now, then the next is scheduled. */
	async refresh(): Promise<void> {
		// A poll that was stopped for running past its bound is logged (chain-stall); the next one runs on the timer.
		await this.#serial(() => this.#tick()).catch(error => {
			if (!(error instanceof StepStalledError)) throw error;
		});
		this.#schedule();
	}

	/** App quit: stop polling. The serve handler stays in the daemon, as the design says. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		if (this.#serverUp) void this.#deps.server.stop().catch(() => undefined);
	}

	// ── serialization, timer, emit ───────────────────────────────────────────

	#serial<T>(task: () => Promise<T>): Promise<T> {
		return this.#chain.run(task);
	}

	#schedule(): void {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		if (!this.#enabled || this.#disposed) return;
		const fast =
			this.#watching ||
			this.#phase === "app-not-running" ||
			this.#phase === "needs-os-approval" ||
			this.#phase === "logging-in" ||
			this.#phase === "detecting" ||
			this.#phase === "starting";
		this.#timer = setTimeout(() => void this.refresh(), fast ? FAST_POLL_MS : POLL_MS);
		this.#timer.unref();
	}

	#emit(): void {
		const state = this.state();
		const text = JSON.stringify(state);
		if (text === this.#lastEmitted) return;
		this.#lastEmitted = text;
		this.#deps.onState(state);
	}

	// ── requests ─────────────────────────────────────────────────────────────

	async #enable(): Promise<void> {
		if (this.#deps.platform === "other") {
			this.#phase = "error";
			this.#detail = "Mobile web needs macOS or Windows";
			this.#emit();
			return;
		}
		this.#deps.prefs.set(MOBILE_WEB_PREFS.enabled, true);
		this.#enabled = true;
		this.#resetRound();
		this.#phase = "detecting";
		this.#emit();
		await this.#tick();
		this.#schedule();
	}

	async #disable(): Promise<void> {
		this.#deps.prefs.set(MOBILE_WEB_PREFS.enabled, false);
		this.#enabled = false;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		this.#phase = "off";
		this.#emit();
		const cli = await this.#cliOrNull();
		const removed: Unpublished = cli ? await this.#unpublish(cli) : { kind: "none" };
		await this.#stopServer();
		this.#resetRound();
		this.#cli = null;
		this.#status = null;
		this.#phones = [];
		this.#host = null;
		this.#port = null;
		this.#detail = removed.kind === "failed" ? removed.detail : null;
		this.#emit();
	}

	#install(): void {
		if (this.#installRequested) return;
		this.#installRequested = true;
		this.#phase = "installing";
		this.#emit();
		this.#deps.setup.installForConnection("tailscale").then(
			item => {
				this.#setupItem = item;
				this.#installRequested = false;
				if (item.presence?.kind === "present") this.#autoStartApp = true;
				return this.refresh();
			},
			(error: unknown) => {
				this.#installRequested = false;
				this.#detail = error instanceof Error ? error.message : String(error);
				return this.refresh();
			},
		);
	}

	async #startApp(): Promise<void> {
		const cli = await this.#cliOrNull();
		if (!cli) return;
		// A stopped Tailscale is started with `up`; the app itself is only opened when it is not running.
		if (this.#status?.backend === "stopped") {
			this.#upTried = false;
			this.#upError = null;
		} else {
			await this.#launchApp(cli);
		}
		await this.#tick();
		this.#schedule();
	}

	async #launchApp(cli: TailscaleCli): Promise<void> {
		this.#appStartedAt = this.#now();
		const result = await this.#deps.startApp(cli.located);
		this.#launchError = result.code === 0 ? null : firstLine(result, "Could not start Tailscale");
	}

	async #login(): Promise<void> {
		const cli = await this.#cliOrNull();
		if (!cli || this.#status?.backend !== "needs-login") return;
		const status = this.#status;
		let url = status?.authUrl ?? this.#loginUrl;
		if (!url) {
			const up = await cli.up(true);
			url = authUrlFromUpJson(up.stdout) ?? extractLoginUrl(`${up.stderr}\n${up.stdout}`);
			if (!url) {
				this.#detail = firstLine(up, "Tailscale gave no sign-in link");
				this.#emit();
				return;
			}
		}
		if (!loginUrlAllowed(url, await this.#controlHostFor(cli))) {
			this.#detail = "Tailscale gave a sign-in link that is not on its login host";
			this.#emit();
			return;
		}
		this.#loginUrl = url;
		this.#loginStartedAt = this.#now();
		this.#detail = null;
		this.#phase = "logging-in";
		this.#emit();
		await this.#deps.openExternal(url);
		this.#schedule();
	}

	async #retry(): Promise<void> {
		if (!this.#enabled) return;
		const cli = await this.#cliOrNull();
		// Our own handler that Funnel exposes is taken down (ours only, by the ownership rules) and put up private.
		if (cli && this.#funnelExposed) await this.#unpublish(cli);
		this.#resetRound();
		this.#cli = null;
		this.#phase = "detecting";
		this.#emit();
		await this.#tick();
		this.#schedule();
	}

	#setAllowedUsers(users: readonly string[]): void {
		const cleaned = cleanLogins(users);
		const fallback = this.#user ? [this.#user] : [];
		const next = cleaned.length > 0 ? cleaned : fallback;
		if (next.length === 0) throw new Error("At least one Tailscale user must be allowed");
		this.#deps.prefs.set(MOBILE_WEB_PREFS.allowedUsers, next);
		this.#emit();
	}

	// ── the poll tick ────────────────────────────────────────────────────────

	async #tick(): Promise<void> {
		if (!this.#enabled || this.#disposed) return;
		try {
			await this.#evaluate();
		} catch (error) {
			throwIfStepStalled();
			this.#published = false;
			this.#phase = "error";
			this.#detail = error instanceof Error ? error.message : String(error);
		}
		this.#emit();
	}

	async #evaluate(): Promise<void> {
		const item = this.#setupItem;
		if (this.#installRequested || item?.phase === "running" || item?.phase === "queued") {
			this.#phase = "installing";
			return;
		}
		const cli = await this.#cliOrNull();
		if (!cli) {
			this.#forgetTailscale();
			this.#phase = "not-installed";
			return;
		}
		const result = await cli.status();
		if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") {
			this.#cli = null;
			this.#forgetTailscale();
			this.#phase = "not-installed";
			return;
		}
		const status = parseStatus(result.stdout);
		if (!status) {
			await this.#unreachable(cli, result);
			return;
		}
		await this.#applyStatus(cli, status);
	}

	/** Tailscale does not answer: its app or daemon is not running (or the OS holds it up). */
	async #unreachable(cli: TailscaleCli, result: ExecResult): Promise<void> {
		this.#status = null;
		this.#phones = [];
		this.#published = false;
		this.#loginUrl = null;
		this.#unreachableSince ??= this.#now();
		if (this.#autoStartApp) {
			this.#autoStartApp = false;
			await this.#launchApp(cli);
		}
		const waitingOnOs = this.#appStartedAt !== null && this.#now() - this.#appStartedAt >= OS_APPROVAL_AFTER_MS;
		this.#phase = waitingOnOs ? "needs-os-approval" : "app-not-running";
		this.#detail = this.#launchError ?? firstLine(result, "Tailscale is not running");
	}

	async #applyStatus(cli: TailscaleCli, status: TailscaleStatus): Promise<void> {
		this.#status = status;
		this.#launchError = null;
		this.#version = status.version;
		this.#updateAvailable = status.updateAvailable;
		this.#phones = status.phones;
		this.#adoptUser(status.login);
		if (status.backend !== "starting" && status.backend !== "no-state") this.#unreachableSince = null;
		if (status.backend !== "running") {
			this.#published = false;
			this.#detail = null;
		}
		if (status.version && (compareVersions(status.version, MIN_TAILSCALE_VERSION) ?? 0) < 0) {
			this.#phase = "error";
			this.#detail = `Tailscale ${MIN_TAILSCALE_VERSION} or newer is required (found ${status.version})`;
			return;
		}
		switch (status.backend) {
			case "running":
				this.#appStartedAt = null;
				this.#guideUrl = null;
				await this.#whenRunning(cli, status);
				return;
			case "needs-login":
				this.#whenNeedsLogin(status);
				return;
			case "stopped":
				await this.#whenStopped(cli);
				return;
			case "needs-machine-auth":
				this.#phase = "needs-machine-approval";
				this.#guideUrl = ADMIN_MACHINES_URL;
				return;
			case "starting":
			case "no-state": {
				this.#unreachableSince ??= this.#now();
				const waitingOnOs = this.#now() - this.#unreachableSince >= OS_APPROVAL_AFTER_MS;
				this.#phase = waitingOnOs ? "needs-os-approval" : "detecting";
				return;
			}
			case "in-use-other-user":
				this.#phase = "serve-blocked";
				this.#detail = "Tailscale is in use by another user of this computer";
				return;
			default:
				this.#phase = "error";
				this.#detail = `Unknown Tailscale state: ${status.backendState}`;
		}
	}

	#whenNeedsLogin(status: TailscaleStatus): void {
		this.#appStartedAt = null;
		this.#guideUrl = null;
		const loggingIn = this.#loginStartedAt !== null && this.#now() - this.#loginStartedAt < LOGIN_TIMEOUT_MS;
		if (!loggingIn) this.#loginStartedAt = null;
		const url = status.authUrl ?? this.#loginUrl;
		this.#loginUrl = url && loginUrlAllowed(url, this.#controlHost) ? url : null;
		this.#phase = loggingIn ? "logging-in" : "needs-login";
	}

	async #whenStopped(cli: TailscaleCli): Promise<void> {
		this.#appStartedAt = null;
		if (!this.#upTried) {
			this.#upTried = true;
			const up = await cli.up(false);
			this.#upError = up.code === 0 ? null : firstLine(up, "tailscale up failed");
			const link = extractLoginUrl(`${up.stderr}\n${up.stdout}`);
			if (link) this.#loginUrl = link;
			const again = parseStatus((await cli.status()).stdout);
			if (again && again.backend !== "stopped") {
				await this.#applyStatus(cli, again);
				return;
			}
		}
		this.#phase = this.#upError ? "error" : "app-not-running";
		this.#detail = this.#upError ?? "Tailscale is turned off";
	}

	async #whenRunning(cli: TailscaleCli, status: TailscaleStatus): Promise<void> {
		const host = status.dnsName;
		const problem = httpsProblem(status) ?? (host ? null : "This machine has no MagicDNS name");
		if (problem || !host) {
			this.#published = false;
			this.#phase = "https-disabled";
			this.#detail = problem;
			this.#guideUrl = this.#serveGuide ?? ADMIN_DNS_URL;
			return;
		}
		this.#host = host;
		const blocked = this.#blocked;
		if (blocked && this.#now() - blocked.at < BLOCK_RETRY_MS) {
			this.#phase = blocked.phase;
			this.#detail = blocked.detail;
			this.#guideUrl = blocked.phase === "https-disabled" ? (this.#serveGuide ?? ADMIN_DNS_URL) : null;
			return;
		}
		await this.#publish(cli, host);
	}

	// ── serve ────────────────────────────────────────────────────────────────

	async #publish(cli: TailscaleCli, host: string): Promise<void> {
		if (this.#phase !== "ready") {
			this.#phase = "starting";
			this.#detail = null;
			this.#emit();
		}
		if (!this.#serverUp) {
			try {
				this.#localPort = (await this.#deps.server.start()).port;
				this.#serverUp = true;
			} catch (error) {
				throwIfStepStalled();
				this.#phase = "error";
				this.#detail = error instanceof Error ? error.message : String(error);
				return;
			}
		}
		const base = `http://127.0.0.1:${this.#localPort}`;
		// Serve joins the target's path to every request's path: only traffic through serve carries the secret.
		const target = `${base}/${this.#deps.serveSecret()}`;
		const read = await cli.serveStatus();
		const config = read.code === 0 ? parseServeStatus(read.stdout) : null;
		if (!config) return this.#block("serve-blocked", firstLine(read, "Could not read the serve configuration"));
		const record = readServeRecord(this.#deps.prefs.get(MOBILE_WEB_PREFS.serve));
		const plan = planPublish(config, host, target, record);
		if (plan.kind === "none") return this.#block("serve-blocked", "No free port for the page on this machine");
		if (funnelOn(config, host, plan.port))
			return this.#refuseFunnel(
				host,
				plan.port,
				handlerIsOurs(config, { host, port: plan.port, target: base }, target),
			);
		if (plan.kind === "publish") {
			this.#published = false;
			const result = await cli.servePublish(plan.port, target);
			if (result.code !== 0) return this.#refused(result);
			const next: ServeRecord = { host, port: plan.port, target: base };
			this.#deps.prefs.set(MOBILE_WEB_PREFS.serve, next);
			const after = await cli.serveStatus();
			const verified = after.code === 0 ? parseServeStatus(after.stdout) : null;
			if (!verified || ownProxy(verified, next, target) !== target) {
				return this.#block("serve-blocked", "Tailscale accepted the command, but the handler is not in place");
			}
			if (funnelOn(verified, host, plan.port)) return this.#refuseFunnel(host, plan.port, true);
		}
		this.#blocked = null;
		this.#serveGuide = null;
		this.#funnelExposed = false;
		// The server answers only to the address it is published at, only to traffic that came through serve (the
		// secret path), and only for an allowed tailnet user.
		this.#deps.server.configure({
			host,
			publicPort: plan.port,
			secure: true,
			servePrefix: this.#deps.serveSecret(),
		});
		this.#published = true;
		this.#port = plan.port;
		this.#phase = "ready";
		this.#detail = null;
		this.#guideUrl = null;
	}

	#block(phase: "serve-blocked" | "https-disabled", detail: string): void {
		this.#published = false;
		this.#blocked = { phase, detail, at: this.#now() };
		this.#phase = phase;
		this.#detail = detail;
		this.#guideUrl = phase === "https-disabled" ? (this.#serveGuide ?? ADMIN_DNS_URL) : null;
	}

	/** `serve` refused: a "turn on HTTPS" page in its words means the tailnet needs it, anything else is a block. */
	#refused(result: ExecResult): void {
		const guide = extractLoginUrl(`${result.stderr}\n${result.stdout}`);
		if (guide) this.#serveGuide = guide;
		this.#block(guide ? "https-disabled" : "serve-blocked", firstLine(result, "tailscale serve failed"));
	}

	/** Funnel exposes our port: nothing is served, the page's server stops. */
	#refuseFunnel(host: string, port: number, ours: boolean): void {
		this.#funnelExposed = true;
		this.#published = ours;
		this.#port = port;
		this.#phase = "serve-blocked";
		this.#detail = `Tailscale Funnel exposes https://${host}:${port} to the internet, so OMPdesk will not serve there`;
		this.#guideUrl = null;
		void this.#stopServer();
	}

	/**
	 * Take our handler down: only when the prefs record matches what is there exactly, then verify that the user's
	 * other handlers are as they were. A record that no longer matches is only forgotten.
	 */
	async #unpublish(cli: TailscaleCli): Promise<Unpublished> {
		const record = readServeRecord(this.#deps.prefs.get(MOBILE_WEB_PREFS.serve));
		if (!record) {
			if (this.#deps.prefs.get(MOBILE_WEB_PREFS.serve) !== undefined)
				this.#deps.prefs.delete(MOBILE_WEB_PREFS.serve);
			return { kind: "none" };
		}
		const read = await cli.serveStatus();
		const before = read.code === 0 ? parseServeStatus(read.stdout) : null;
		if (!before) return { kind: "failed", detail: firstLine(read, "Could not read the serve configuration") };
		if (!handlerIsOurs(before, record, `${record.target}/${this.#deps.serveSecret()}`)) {
			this.#deps.prefs.delete(MOBILE_WEB_PREFS.serve);
			return { kind: "record-dropped" };
		}
		const off = await cli.serveOff(record.port);
		if (off.code !== 0) return { kind: "failed", detail: firstLine(off, "tailscale serve off failed") };
		const check = await cli.serveStatus();
		const after = check.code === 0 ? parseServeStatus(check.stdout) : null;
		this.#deps.prefs.delete(MOBILE_WEB_PREFS.serve);
		this.#published = false;
		if (!after) return { kind: "failed", detail: "Could not confirm that the serve handler was removed" };
		if (!sameServeConfig(after, withoutPort(before, record.port))) {
			return {
				kind: "failed",
				detail: "Tailscale's serve configuration is not what it should be after removing OMPdesk's handler",
			};
		}
		return { kind: "removed" };
	}

	async #stopServer(): Promise<void> {
		if (!this.#serverUp) return;
		this.#serverUp = false;
		await this.#deps.server.stop().catch(() => undefined);
		throwIfStepStalled();
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	async #cliOrNull(): Promise<TailscaleCli | null> {
		if (this.#cli) return this.#cli;
		const located = await this.#deps.locate();
		this.#cli = located ? new TailscaleCli(located, this.#deps.exec) : null;
		return this.#cli;
	}

	/** The host of the control server this Tailscale signs in to (a self-hosted tailnet), asked once. */
	async #controlHostFor(cli: TailscaleCli): Promise<string | null> {
		if (this.#controlHost === null) {
			const result = await cli.debugPrefs();
			this.#controlHost = result.code === 0 ? controlHostFromPrefs(result.stdout) : null;
		}
		return this.#controlHost;
	}

	/** This computer's tailnet user: allowed by default, so the allow list is never empty once it is known. */
	#adoptUser(login: string | null): void {
		if (!login) return;
		this.#user = login;
		const stored = this.#deps.prefs.get(MOBILE_WEB_PREFS.allowedUsers);
		if (!Array.isArray(stored) || cleanLogins(stored).length === 0) {
			this.#deps.prefs.set(MOBILE_WEB_PREFS.allowedUsers, [login]);
		}
	}

	#forgetTailscale(): void {
		this.#status = null;
		this.#phones = [];
		this.#published = false;
		this.#loginUrl = null;
		this.#guideUrl = null;
		this.#detail = null;
		this.#version = null;
	}

	/** A fresh round: the one-shot steps (`up`, the app start) may run again. */
	#resetRound(): void {
		this.#upTried = false;
		this.#upError = null;
		this.#blocked = null;
		this.#serveGuide = null;
		this.#funnelExposed = false;
		this.#loginStartedAt = null;
		this.#appStartedAt = null;
		this.#launchError = null;
		this.#unreachableSince = null;
		this.#loginUrl = null;
		this.#guideUrl = null;
		this.#detail = null;
		this.#published = false;
	}
}
