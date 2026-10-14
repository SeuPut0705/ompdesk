/**
 * In-app GitHub sign-in: `gh auth login --web` in a PTY (gh insists on a TTY),
 * its device code handed to the renderer, gh's "Press Enter to open" pause held
 * until the user asked for the GitHub page (so a browser never covers a code
 * nobody has seen), then the commit identity filled from the account where git
 * has none. One sign-in at a time; a new start ends the old one. Re-derived
 * from mixdog's github-cli.ts (Apache-2.0) facts, not its code.
 */
import {
	EMPTY_GITHUB_AUTH_STATE,
	type GithubAuthAction,
	type GithubAuthState,
	type GithubLoginFailure,
	githubLoginLive,
} from "../../shared/github-auth";
import {
	fillGitIdentity,
	type GhRunner,
	ghAccountIdentity,
	ghAuthStatus,
	ghLogout,
	ghSwitch,
	ghVersion,
	gitIdentity,
} from "./cli";
import type { PtyChunk, PtyHandle, PtyLauncher } from "./pty";

export interface GithubAuthDeps {
	/** Absolute gh path, or null when not installed. */
	resolveGh(): Promise<string | null>;
	/** Absolute git path, or null when no usable git exists. */
	resolveGit(): Promise<string | null>;
	run: GhRunner;
	pty: PtyLauncher;
	/** The whole environment `gh auth login` runs with. */
	loginEnv(): Promise<Record<string, string>>;
	/** The login's working directory. */
	home: string;
	onState(state: GithubAuthState): void;
	/** gh's device code expires; the flow ends on its own after this. */
	loginTimeoutMs?: number;
}

export const LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"];
const DEFAULT_DEVICE_URL = "https://github.com/login/device";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 20_000;
/** A completed status check is reused this long unless a caller forces a new one. */
const CHECK_TTL_MS = 10_000;
// CSI, OSC and charset escapes; gh colours and moves the cursor even in a PTY.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;
// "First copy your one-time code: XXXX-XXXX", or, with gh's clipboard option,
// "One-time code (XXXX-XXXX) copied to clipboard".
const CODE = /one-time code(?::\s*|\s*\()([A-Z0-9-]{6,})/i;
const DEVICE_URL = /(https:\/\/github\.com\/login\/device\S*)/;

interface ActiveLogin {
	pty: PtyHandle | null;
	output: string;
	answeredGitPrompt: boolean;
	pressedEnter: boolean;
	opened: boolean;
	timer: NodeJS.Timeout | undefined;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class GithubAuthService {
	readonly #deps: GithubAuthDeps;
	#state: GithubAuthState = EMPTY_GITHUB_AUTH_STATE;
	#login: ActiveLogin | null = null;
	#check: Promise<void> | null = null;
	#checkedAt = 0;

	constructor(deps: GithubAuthDeps) {
		this.#deps = deps;
	}

	state(): GithubAuthState {
		return this.#state;
	}

	#set(patch: Partial<GithubAuthState>): void {
		this.#state = { ...this.#state, ...patch };
		this.#deps.onState(this.#state);
	}

	/** Re-read gh and git; a recent check is reused unless `force`, a running one is shared. */
	async refresh(force = false): Promise<GithubAuthState> {
		if (!force && this.#check) await this.#check;
		else if (force || Date.now() - this.#checkedAt >= CHECK_TTL_MS || this.#state.status === null) {
			const previous = this.#check ?? Promise.resolve();
			const check = previous.then(() => this.#runCheck());
			this.#check = check;
			try {
				await check;
			} finally {
				if (this.#check === check) this.#check = null;
			}
		}
		return this.#state;
	}

	async #runCheck(): Promise<void> {
		this.#set({ checking: true });
		try {
			const { run } = this.#deps;
			const [gh, git] = await Promise.all([this.#deps.resolveGh(), this.#deps.resolveGit()]);
			const [identity, version, auth] = await Promise.all([
				git ? gitIdentity(run, git) : null,
				gh ? ghVersion(run, gh) : null,
				gh ? ghAuthStatus(run, gh) : { authenticated: false, login: null, otherAccounts: [] },
			]);
			this.#checkedAt = Date.now();
			this.#set({
				checking: false,
				identity,
				status: { installed: gh !== null, version, ...auth },
				error: this.#state.error?.action === "check" ? null : this.#state.error,
			});
		} catch (error) {
			this.#set({ checking: false, error: { action: "check", message: message(error) } });
		}
	}

	async startLogin(): Promise<GithubAuthState> {
		this.cancelLogin();
		const login: ActiveLogin = {
			pty: null,
			output: "",
			answeredGitPrompt: false,
			pressedEnter: false,
			opened: false,
			timer: undefined,
		};
		this.#login = login;
		this.#set({ flow: { state: "starting" }, identityFilled: [], error: null });
		const gh = await this.#deps.resolveGh();
		if (this.#login !== login) return this.#state;
		if (!gh) {
			this.#fail(login, "gh_missing");
			return this.#state;
		}
		let pty: PtyHandle;
		try {
			pty = await this.#deps.pty({
				application: gh,
				args: LOGIN_ARGS,
				cwd: this.#deps.home,
				env: await this.#deps.loginEnv(),
			});
		} catch (error) {
			if (this.#login === login) this.#fail(login, "spawn_failed", message(error));
			return this.#state;
		}
		if (this.#login !== login) {
			pty.kill();
			return this.#state;
		}
		login.pty = pty;
		login.timer = setTimeout(() => this.#fail(login, "timeout"), this.#deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
		void this.#pump(login, pty);
		return this.#state;
	}

	async #pump(login: ActiveLogin, pty: PtyHandle): Promise<void> {
		for (;;) {
			let chunk: PtyChunk;
			try {
				chunk = await pty.read();
			} catch (error) {
				chunk = { data: "", exited: true, error: message(error) };
			}
			if (this.#login !== login) return;
			if (chunk.data) this.#output(login, chunk.data);
			if (chunk.exited) {
				await this.#exited(login, chunk);
				return;
			}
		}
	}

	#output(login: ActiveLogin, data: string): void {
		login.output = (login.output + data.replace(ANSI, "").replace(/\r/g, "")).slice(-OUTPUT_LIMIT);
		// Accept gh's default: Git operations use the GitHub credentials.
		if (!login.answeredGitPrompt && /Authenticate Git with your GitHub credentials/i.test(login.output)) {
			login.answeredGitPrompt = true;
			login.pty?.write("\r");
		}
		const code = CODE.exec(login.output)?.[1];
		if (code && this.#state.flow?.state === "starting") {
			const url = DEVICE_URL.exec(login.output)?.[1] ?? DEFAULT_DEVICE_URL;
			this.#set({ flow: { state: "code", code, url, opened: login.opened } });
		}
		this.#pressEnterToOpen(login);
	}

	#pressEnterToOpen(login: ActiveLogin): void {
		if (login.pressedEnter || !login.opened || !/Press Enter to open/i.test(login.output)) return;
		login.pressedEnter = true;
		login.pty?.write("\r");
	}

	/**
	 * The user asked for the GitHub page (the renderer opens it): release gh's
	 * "Press Enter to open" pause, after which gh polls for the approval. gh's own
	 * browser launcher is a no-op (`loginEnv`), so nothing opens twice.
	 */
	openLogin(): GithubAuthState {
		const login = this.#login;
		const flow = this.#state.flow;
		if (!login || flow?.state !== "code") return this.#state;
		login.opened = true;
		this.#set({ flow: { ...flow, opened: true } });
		this.#pressEnterToOpen(login);
		return this.#state;
	}

	async #exited(login: ActiveLogin, chunk: PtyChunk): Promise<void> {
		clearTimeout(login.timer);
		login.pty = null;
		if (chunk.exitCode !== 0) {
			const tail = login.output.trim().split("\n").filter(Boolean).slice(-3).join("\n");
			this.#fail(login, "exited", chunk.error || tail || `gh exited with code ${chunk.exitCode ?? "?"}`);
			return;
		}
		const state = await this.refresh(true);
		if (this.#login !== login) return;
		if (!state.status?.authenticated) {
			this.#fail(login, "not_signed_in");
			return;
		}
		this.#login = null;
		this.#set({ flow: { state: "success", login: state.status.login } });
		await this.fillIdentity();
	}

	#fail(login: ActiveLogin, reason: GithubLoginFailure, detail?: string): void {
		if (this.#login !== login) return;
		clearTimeout(login.timer);
		login.pty?.kill();
		this.#login = null;
		this.#set({ flow: { state: "failed", reason, ...(detail ? { detail } : {}) } });
	}

	/** End the live sign-in (if any) and forget it. */
	cancelLogin(): GithubAuthState {
		const login = this.#login;
		if (!login) return this.#state;
		clearTimeout(login.timer);
		login.pty?.kill();
		this.#login = null;
		if (githubLoginLive(this.#state.flow)) this.#set({ flow: null });
		return this.#state;
	}

	async #act(action: GithubAuthAction, work: () => Promise<void>): Promise<GithubAuthState> {
		this.#set({ busy: action, error: null });
		try {
			await work();
			this.#set({ busy: null });
		} catch (error) {
			this.#set({ busy: null, error: { action, message: message(error) } });
		}
		return this.#state;
	}

	async #gh(): Promise<string> {
		const gh = await this.#deps.resolveGh();
		if (!gh) throw new Error("GitHub CLI (gh) is not installed");
		return gh;
	}

	/** Set git's `user.name` / `user.email` from the signed-in account, each only while empty. */
	fillIdentity(): Promise<GithubAuthState> {
		return this.#act("identity", async () => {
			const [gh, git] = await Promise.all([this.#gh(), this.#deps.resolveGit()]);
			if (!git) throw new Error("git is not installed");
			const account = await ghAccountIdentity(this.#deps.run, gh);
			const identityFilled = await fillGitIdentity(this.#deps.run, git, account);
			this.#set({ identityFilled, identity: await gitIdentity(this.#deps.run, git) });
		});
	}

	logout(): Promise<GithubAuthState> {
		this.cancelLogin();
		return this.#act("logout", async () => {
			await ghLogout(this.#deps.run, await this.#gh(), this.#state.status?.login ?? null);
			this.#set({ flow: null, identityFilled: [] });
			await this.refresh(true);
		});
	}

	/** Make another already signed-in account active (`gh auth switch`). */
	switchAccount(login: unknown): Promise<GithubAuthState> {
		return this.#act("switch", async () => {
			if (typeof login !== "string" || !this.#state.status?.otherAccounts.includes(login))
				throw new Error(`Not a signed-in GitHub account: ${String(login)}`);
			this.cancelLogin();
			await ghSwitch(this.#deps.run, await this.#gh(), login);
			this.#set({ flow: null, identityFilled: [] });
			await this.refresh(true);
		});
	}

	dispose(): void {
		this.cancelLogin();
	}
}
