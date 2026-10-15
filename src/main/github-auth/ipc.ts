/**
 * GitHub sign-in IPC and the production wiring of GithubAuthService: gh and git
 * from the spawn PATH (the user's installs, then the managed tools directory),
 * the login PTY in the stock helper. No handler takes a command or a path from
 * the renderer; a switch accepts only a login gh itself listed.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { GithubAuthState } from "../../shared/github-auth";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { ghText, resolveBin } from "../local/git/exec";
import { spawnPath } from "../shell-env";
import { stockPtyLauncher } from "./pty";
import { GithubAuthService } from "./service";

export interface GithubAuthIpcTarget {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** gh's browser launcher during sign-in: exits 0 and ignores the URL; the renderer opens the page itself. */
const NO_OP_BROWSER = process.platform === "win32" ? "cmd /c exit 0" : "true";

/**
 * git, unless it is macOS's /usr/bin/git stub without the Command Line Tools:
 * running that opens Apple's install dialog (same check as setup's detectGit).
 */
async function usableGit(): Promise<string | null> {
	const git = await resolveBin("git");
	if (process.platform !== "darwin" || git !== "/usr/bin/git") return git;
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 }, error => resolve(error ? null : git));
	return promise;
}

async function loginEnv(): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PATH: await spawnPath(),
		TERM: "xterm-256color",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_BROWSER: NO_OP_BROWSER,
		BROWSER: NO_OP_BROWSER,
	});
	return env;
}

export function createGithubAuthService(onState: (state: GithubAuthState) => void): GithubAuthService {
	return new GithubAuthService({
		resolveGh: () => resolveBin("gh"),
		resolveGit: usableGit,
		run: (bin, args) => ghText(homedir(), bin, args),
		pty: stockPtyLauncher,
		loginEnv,
		home: homedir(),
		onState,
	});
}

export function registerGithubAuthIpc(ipc: GithubAuthIpcTarget, service: GithubAuthService): void {
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_REFRESH, (_event, force) => service.refresh(force === true));
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_LOGIN_START, () => service.startLogin());
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_LOGIN_OPEN, () => service.openLogin());
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_LOGIN_CANCEL, () => service.cancelLogin());
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_LOGOUT, () => service.logout());
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_SWITCH, (_event, login) => service.switchAccount(login));
	ipc.handle(IPC_COMMANDS.GITHUB_AUTH_FILL_IDENTITY, () => service.fillIdentity());
	ipc.handle(IPC_COMMANDS.GITHUB_PRODUCT_STAR, (_event, star) => service.productStar(star === true));
}
