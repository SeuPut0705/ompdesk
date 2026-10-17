/**
 * Running the `tailscale` CLI. Every call is an argument array (no shell; a Windows `.cmd` stand-in goes through
 * cmd.exe the way `spawn.ts` does it) with a 10 s ceiling, through an injectable executor so the whole of Mobile
 * web's logic runs against fixtures in tests. Decisions are only ever made from `--json` output; the human text
 * on stderr is shown to the user and searched for a `login.tailscale.com` link, nothing else.
 */
import { execFile, spawn } from "node:child_process";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import type { LocatedTailscale } from "./locate";

export const CLI_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** A whois answers from the daemon's own netmap: slower than this is a daemon in trouble. */
export const WHOIS_TIMEOUT_MS = 4_000;

export interface ExecOptions {
	/** Added over the app's own environment. */
	env?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * - `code`: the exit code; null when the process did not exit by itself (timeout, could not start).
 * - `timedOut`: the ceiling killed it (its partial output is kept).
 * - `spawnError`: it could not be started (`ENOENT`, `EACCES`).
 */
export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnError: string | null;
}

export type TailscaleExecutor = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** The real executor: `execFile` over the spawn helpers. */
export const execFileExecutor: TailscaleExecutor = (file, args, options = {}) => {
	const { promise, resolve } = Promise.withResolvers<ExecResult>();
	const platform = process.platform;
	execFile(
		spawnCommand(file, platform),
		spawnArgs(file, args, platform),
		{
			env: { ...process.env, ...options.env },
			shell: needsShell(file, platform),
			timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: MAX_OUTPUT,
			encoding: "utf8",
		},
		(error, stdout, stderr) => {
			if (!error) {
				resolve({ code: 0, stdout, stderr, timedOut: false, spawnError: null });
				return;
			}
			const code = typeof error.code === "number" ? error.code : null;
			resolve({
				code,
				stdout,
				stderr: stderr || (code === null ? error.message : ""),
				timedOut: error.killed === true && code === null && typeof error.code !== "string",
				spawnError: typeof error.code === "string" ? error.code : null,
			});
		},
	);
	return promise;
};

/** One located Tailscale CLI: what it needs in its environment and the calls Mobile web makes. */
export class TailscaleCli {
	readonly located: LocatedTailscale;
	readonly #exec: TailscaleExecutor;

	constructor(located: LocatedTailscale, exec: TailscaleExecutor) {
		this.located = located;
		this.#exec = exec;
	}

	run(args: string[], timeoutMs: number = CLI_TIMEOUT_MS): Promise<ExecResult> {
		return this.#exec(this.located.path, args, { env: this.located.env, timeoutMs });
	}

	status(): Promise<ExecResult> {
		return this.run(["status", "--json"]);
	}

	serveStatus(): Promise<ExecResult> {
		return this.run(["serve", "status", "--json"]);
	}

	/** `up` brings Tailscale up; with `--json` it reports the sign-in link while it waits, so it is cut short. */
	up(json: boolean): Promise<ExecResult> {
		return this.run(json ? ["up", "--json"] : ["up"]);
	}

	/** Read-only: the control server's URL, for a self-hosted tailnet's sign-in page. */
	debugPrefs(): Promise<ExecResult> {
		return this.run(["debug", "prefs"]);
	}

	/** Read-only: the node and user behind a tailnet address (`ip` is already checked to be one). */
	whois(ip: string): Promise<ExecResult> {
		return this.run(["whois", "--json", ip], WHOIS_TIMEOUT_MS);
	}

	/** Publish `https://<this machine>:<port>` to the tailnet, proxied to `target`. Only ever our own port. */
	servePublish(port: number, target: string): Promise<ExecResult> {
		return this.run(["serve", "--bg", `--https=${port}`, target]);
	}

	/** Remove the handler on `port`. Only ever called for a handler this OMPdesk published. */
	serveOff(port: number): Promise<ExecResult> {
		return this.run(["serve", `--https=${port}`, "off"]);
	}
}

/** The first non-empty line of what a failed call said: what Settings shows under "Details". */
export function firstLine(result: Pick<ExecResult, "stderr" | "stdout">, fallback: string): string {
	const text = (result.stderr || result.stdout)
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(Boolean);
	return text ?? fallback;
}

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/[^\s"'<>)]*/;

/** The `login.tailscale.com` link in a command's human output (sign-in, "enable HTTPS"), or null. */
export function extractLoginUrl(text: string): string | null {
	return LOGIN_URL.exec(text)?.[0] ?? null;
}

/** The sign-in link in `up --json` output: its `AuthURL`, from the first line that has one. */
export function authUrlFromUpJson(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(text);
			const url = typeof parsed === "object" && parsed !== null && "AuthURL" in parsed ? parsed.AuthURL : undefined;
			if (typeof url === "string" && url) return url;
		} catch {
			// A partial line (the call was cut short): the next one may be whole.
		}
	}
	return null;
}

/**
 * Whether `openExternal` may be given `url` for a sign-in: https on Tailscale's own login host, or on the host of
 * the control server this tailnet signs in to (`controlHost`, a self-hosted one). Nothing else is ever opened.
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

/** The host of `ControlURL` in `debug prefs` JSON, or null. */
export function controlHostFromPrefs(stdout: string): string | null {
	try {
		const parsed: unknown = JSON.parse(stdout);
		const url =
			typeof parsed === "object" && parsed !== null && "ControlURL" in parsed ? parsed.ControlURL : undefined;
		return typeof url === "string" && url ? new URL(url).hostname : null;
	} catch {
		return null;
	}
}

/**
 * Start the Tailscale app: `open -a Tailscale` on macOS, `tailscale-ipn.exe` beside the CLI on Windows.
 * `override` (`OMP_GUI_TEST_TAILSCALE_OPEN`) is a test's stand-in, run instead, so a test never starts the
 * user's own Tailscale.
 */
export function startTailscaleApp(
	located: LocatedTailscale,
	platform: "darwin" | "win32",
	exec: TailscaleExecutor,
	override: string | null,
): Promise<ExecResult> {
	if (override) return exec(override, []);
	if (platform === "darwin") {
		if (!located.app) {
			const stderr = "This Tailscale has no app to start: start its daemon (tailscaled) yourself";
			return Promise.resolve({ code: 1, stdout: "", stderr, timedOut: false, spawnError: null });
		}
		return exec("/usr/bin/open", ["-a", located.app]);
	}
	// The tray app keeps running after this returns, so it is started detached rather than awaited.
	const ipn = located.path.replace(/tailscale\.exe$/i, "tailscale-ipn.exe");
	const { promise, resolve } = Promise.withResolvers<ExecResult>();
	const child = spawn(ipn, [], { detached: true, stdio: "ignore" });
	child.once("error", error => {
		const code = (error as NodeJS.ErrnoException).code;
		resolve({ code: null, stdout: "", stderr: error.message, timedOut: false, spawnError: code ?? "ERROR" });
	});
	child.once("spawn", () => {
		child.unref();
		resolve({ code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null });
	});
	return promise;
}
