/**
 * The `tailscale` CLI, as main asks for it. Running it, reading what it prints and the rules of publishing with
 * `serve` are the core process's (`native/ompdesk/crates/core/src/tailscale/`); this file is their typed client.
 * Main decides how the CLI runs and hands that over with every request: the binary a lookup found, main's whole
 * environment with the located CLI's own variables over it, a 10 s ceiling and a 4 MiB cap. Decisions are only ever
 * made from `--json` output; the human text is shown to the user and searched for a `login.tailscale.com` link,
 * nothing else.
 *
 * A request made in one of Mobile web's steps is held to that step: it never starts in a stopped step, a step
 * stopped while it runs has its CLI ended by the core (asked, then killed 2 s later) with no other started, the
 * chain's next step waits until the core is done with it, and the stopped step goes no further. A core process that
 * cannot answer reads as a CLI that could not run: no exit code, the core's message as what it said.
 */
import { spawn } from "node:child_process";
import { CoreError, core } from "../core/process";
import type { CoreRunner } from "../local/git/exec";
import { currentStepSignal, throwIfStepStalled, trackEffect } from "../serial-chain";
import type { LocatedTailscale } from "./locate";
import type { TailscaleStatus } from "./status";
import type { TailnetPeer } from "./whois";

export const CLI_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** A whois answers from the daemon's own netmap: slower than this is a daemon in trouble. */
export const WHOIS_TIMEOUT_MS = 4_000;
/** Room past a request's CLI ceilings: the end of a CLI that ran past one, and the round trip. */
const CORE_SLACK_MS = 2_000 + 5_000;

/** Main's environment now, with `extra` over it, as the plain strings a request carries. */
function mainEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	return { ...env, ...extra };
}

/** What a run outside the located CLI gets (`plutil`, the app's starter): main's environment and the CLI's limits. */
export function runRules(): { env: Record<string, string>; timeoutMs: number; maxBytes: number } {
	return { env: mainEnv(), timeoutMs: CLI_TIMEOUT_MS, maxBytes: MAX_OUTPUT };
}

/**
 * A request to the core whose CLI runs take `cliMs` in all, held to the chain step it is made in (see the top of
 * this file). Outside any step it is a plain request.
 */
async function tailscaleRequest<T>(method: string, params: object, cliMs: number): Promise<T> {
	throwIfStepStalled();
	const ended = Promise.withResolvers<void>();
	void trackEffect(method, ended.promise);
	try {
		const answer = await core().call<T>(method, params, {
			timeoutMs: cliMs + CORE_SLACK_MS,
			signal: currentStepSignal(),
			onEnded: ended.resolve,
		});
		throwIfStepStalled();
		return answer.result;
	} catch (error) {
		throwIfStepStalled();
		throw error;
	}
}

/** `status --json` as one call reported it. */
export interface StatusRead {
	/** The exit code; null when the CLI did not exit by itself (its ceiling) or could not start. */
	code: number | null;
	/** It could not be started (`ENOENT`, `EACCES`). */
	spawnError: string | null;
	/** The first non-empty line of what the call said (its stderr, else its stdout): what Settings shows under "Details". */
	line: string | null;
	/** The document it printed, whatever its exit code; null when it printed none. */
	status: TailscaleStatus | null;
	/**
	 * Why `serve` over HTTPS cannot work on the tailnet that document describes, or null when it can: MagicDNS is
	 * off, the tailnet has no certificate domain for this machine, or `https` is not among its capabilities.
	 */
	httpsProblem: string | null;
}

/** `up` as one call reported it. */
export interface UpResult {
	code: number | null;
	line: string | null;
	/** The sign-in link in `up --json` output: its `AuthURL`, from the first line that has one. */
	authUrl: string | null;
	/** The `login.tailscale.com` link in what it said. */
	loginUrl: string | null;
}

/** "Start the Tailscale app" as it ended: 0 when it started. */
export interface AppStart {
	code: number | null;
	line: string | null;
}

/** What OMPdesk published: the prefs record `mobileWeb.serve`. */
export interface ServeRecord {
	host: string;
	port: number;
	/** `http://127.0.0.1:<local port>`, without the secret path. */
	target: string;
}

export type Published =
	/** The serve configuration could not be read, or no port is free. */
	| { kind: "blocked"; detail: string }
	/** Tailscale lets the internet reach the port: nothing is served there. `ours`: the handler on it is OMPdesk's. */
	| { kind: "exposed"; port: number; ours: boolean }
	/** `serve` refused; `guide` is the `login.tailscale.com` page it named ("enable HTTPS"). */
	| { kind: "refused"; detail: string; guide: string | null }
	/** Our handler is already there with this target. */
	| { kind: "reuse"; port: number }
	/** `serve` took the command; `confirm` says whether the handler is in place. */
	| { kind: "published"; port: number };

/** After a publish: in place and private, not in place, or in place and reachable from the internet. */
export type Confirmed = "ready" | "missing" | "exposed";

export type Unpublished =
	/** No record: nothing was published. */
	| { kind: "none" }
	/** The handler is no longer exactly what the record says: only the record goes. */
	| { kind: "record-dropped" }
	| { kind: "removed" }
	/** `off`: our handler was taken down before this failed, so the record goes; else it stays. */
	| { kind: "failed"; detail: string; off: boolean };

/** One located Tailscale CLI: what it needs in its environment and the calls Mobile web and computer sharing make. */
export class TailscaleCli {
	readonly located: LocatedTailscale;

	constructor(located: LocatedTailscale) {
		this.located = located;
	}

	#runner(): CoreRunner {
		return {
			bin: this.located.path,
			args: [],
			env: mainEnv(this.located.env),
			timeoutMs: CLI_TIMEOUT_MS,
			maxBytes: MAX_OUTPUT,
		};
	}

	/** `method` over this CLI; `failed` words the answer of a core process that could not give one. */
	async #ask<T>(method: string, params: object, cliMs: number, failed: (message: string) => T): Promise<T> {
		try {
			return await tailscaleRequest<T>(method, { tailscale: this.#runner(), ...params }, cliMs);
		} catch (error) {
			if (error instanceof CoreError) return failed(error.message);
			throw error;
		}
	}

	status(): Promise<StatusRead> {
		return this.#ask("tailscale.status", {}, CLI_TIMEOUT_MS, line => ({
			code: null,
			spawnError: null,
			line,
			status: null,
			httpsProblem: null,
		}));
	}

	/** Read-only: the node and user behind a tailnet address (`ip` is already checked to be one). */
	whois(ip: string): Promise<TailnetPeer | null> {
		return this.#ask("tailscale.whois", { ip, timeoutMs: WHOIS_TIMEOUT_MS }, WHOIS_TIMEOUT_MS, () => null);
	}

	/** `up` brings Tailscale up; with `--json` it reports the sign-in link while it waits, so it is cut short. */
	up(json: boolean, timeoutMs: number = CLI_TIMEOUT_MS): Promise<UpResult> {
		return this.#ask("tailscale.up", { json, timeoutMs }, timeoutMs, line => ({
			code: null,
			line,
			authUrl: null,
			loginUrl: null,
		}));
	}

	/** Read-only: the host of the control server this Tailscale signs in to (a self-hosted tailnet), or null. */
	controlHost(): Promise<string | null> {
		return this.#ask("tailscale.controlHost", {}, CLI_TIMEOUT_MS, () => null);
	}

	/** The installed version, or null when the CLI does not say within `timeoutMs`. */
	version(timeoutMs: number): Promise<string | null> {
		return this.#ask("tailscale.version", { timeoutMs }, timeoutMs, () => null);
	}

	/**
	 * Publish `https://<host>:<port>` to the tailnet, proxied to `target` (`base` plus the secret path): our own
	 * earlier port when `record` (the pref, whatever it holds) still names our handler, else the first port from
	 * `first` up that nothing uses. Only ever our own port.
	 */
	publish(request: {
		host: string;
		target: string;
		base: string;
		record: unknown;
		first: number;
	}): Promise<Published> {
		const record = request.record ?? null;
		return this.#ask("tailscale.publish", { ...request, record }, 2 * CLI_TIMEOUT_MS, detail => ({
			kind: "blocked",
			detail,
		}));
	}

	/** After `publish` answered `published`: whether the handler is in place, proxying to exactly `target`. */
	confirm(request: { host: string; port: number; base: string; target: string }): Promise<Confirmed> {
		return this.#ask("tailscale.confirm", request, CLI_TIMEOUT_MS, () => "missing");
	}

	/**
	 * Take our handler down: only when `record` (the pref, whatever it holds) matches what is there exactly, and
	 * then check that the user's other handlers are as they were. Only ever a handler this OMPdesk published.
	 */
	unpublish(record: unknown, secret: string): Promise<Unpublished> {
		const params = { record: record ?? null, secret };
		return this.#ask("tailscale.unpublish", params, 3 * CLI_TIMEOUT_MS, detail => ({
			kind: "failed",
			detail,
			off: false,
		}));
	}
}

/**
 * Whether `openExternal` may be given `url` for a sign-in: https on Tailscale's own login host, or on the host of
 * the control server this tailnet signs in to (`controlHost`, a self-hosted one). Nothing else is ever opened. Main's
 * own check of what it hands Electron, read while a status is applied.
 */
export function loginUrlAllowed(url: string, controlHost: string | null): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
	const host = parsed.hostname.toLowerCase();
	return host === "login.tailscale.com" || (controlHost !== null && host === controlHost.toLowerCase());
}

/**
 * Start the Tailscale app: `open -a Tailscale` on macOS, `tailscale-ipn.exe` beside the CLI on Windows.
 * `standIn` (`OMP_GUI_TEST_TAILSCALE_OPEN`) is a test's stand-in, run instead, so a test never starts the user's
 * own Tailscale.
 */
export async function startTailscaleApp(
	located: LocatedTailscale,
	platform: "darwin" | "win32",
	standIn: string | null,
): Promise<AppStart> {
	if (standIn || platform === "darwin") {
		try {
			const params = { platform, standIn, app: located.app, rules: runRules() };
			return await tailscaleRequest<AppStart>("tailscale.startApp", params, CLI_TIMEOUT_MS);
		} catch (error) {
			if (error instanceof CoreError) return { code: null, line: error.message };
			throw error;
		}
	}
	// The tray app keeps running after OMPdesk quits, and every process the core starts ends with it: main starts
	// this one itself, detached rather than awaited.
	const ipn = located.path.replace(/tailscale\.exe$/i, "tailscale-ipn.exe");
	const { promise, resolve } = Promise.withResolvers<AppStart>();
	const child = spawn(ipn, [], { detached: true, stdio: "ignore" });
	child.once("error", error => resolve({ code: null, line: error.message }));
	child.once("spawn", () => {
		child.unref();
		resolve({ code: 0, line: null });
	});
	return promise;
}
