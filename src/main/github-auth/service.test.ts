/**
 * GitHub sign-in against a fake gh (a bun script with gh's output and prompts)
 * and the real git on a temp HOME / GIT_CONFIG_GLOBAL, so the user's own gh
 * login and git config are never read or written. The PTY is a plain pipe
 * here; the stock PtySession path runs in e2e/github-sign-in.e2e.ts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthState } from "../../shared/github-auth";
import { RM_TEMP } from "../test-fake-omp";
import { accountsFromAuthOutput, loginFromAuthOutput, type RunResult } from "./cli";
import type { PtyChunk, PtyLauncher } from "./pty";
import { GithubAuthService, LOGIN_ARGS } from "./service";
import { type FakeGhAccount, seedFakeGh, writeFakeGh } from "./test-fake-gh";

/** The fake gh runs as `bun <script>` (no shebangs on Windows); git is the real one. */
function argv(bin: string, args: string[]): [string, string[]] {
	return bin === gh ? ["bun", [gh, ...args]] : [bin, args];
}
let root: string;
let gh: string;
let env: Record<string, string>;
const states: GithubAuthState[] = [];
const services: GithubAuthService[] = [];

function run(bin: string, args: string[]): Promise<RunResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	const [command, commandArgs] = argv(bin, args);
	const child = spawn(command, commandArgs, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
	child.on("error", reject);
	child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
	return promise;
}

/** A pipe "PTY": the fake gh prompts on stdout and reads answers from stdin. */
const pipePty: PtyLauncher = async ({ application, args, cwd, env: spawnEnv }) => {
	const [command, commandArgs] = argv(application, args);
	const child = spawn(command, commandArgs, {
		cwd,
		env: spawnEnv,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const queue: PtyChunk[] = [];
	let wake: (() => void) | null = null;
	const push = (chunk: PtyChunk) => {
		queue.push(chunk);
		wake?.();
	};
	child.stdout.setEncoding("utf8").on("data", (data: string) => push({ data, exited: false }));
	child.stderr.setEncoding("utf8").on("data", (data: string) => push({ data, exited: false }));
	child.on("close", code => push({ data: "", exited: true, exitCode: code ?? 1 }));
	return {
		async read() {
			while (queue.length === 0) {
				const { promise, resolve } = Promise.withResolvers<void>();
				wake = resolve;
				await promise;
			}
			const chunk = queue.shift();
			if (!chunk) throw new Error("empty queue");
			return chunk;
		},
		write: data => child.stdin.write(data.replace(/\r/g, "\n")),
		kill: () => child.kill(),
	};
};

function service(extra: Record<string, string> = {}, loginTimeoutMs?: number): GithubAuthService {
	Object.assign(env, extra);
	const created = new GithubAuthService({
		resolveGh: async () => gh,
		resolveGit: async () => "git",
		run,
		pty: pipePty,
		loginEnv: async () => env,
		home: root,
		onState: state => states.push(state),
		loginTimeoutMs,
	});
	services.push(created);
	return created;
}

async function seed(accounts: FakeGhAccount[]): Promise<void> {
	await seedFakeGh(env.FAKE_GH_STATE, accounts);
}

const gitConfig = async (key: string) => (await run("git", ["config", "--global", "--get", key])).stdout.trim();

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ompdesk-github-auth-"));
	gh = await writeFakeGh(root);
	env = {
		PATH: process.env.PATH ?? "",
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		HOME: root,
		USERPROFILE: root,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		FAKE_GH_STATE: join(root, "gh-state.json"),
	};
	await writeFile(env.GIT_CONFIG_GLOBAL, "");
	await seed([]);
	states.length = 0;
});

afterEach(async () => {
	for (const created of services) created.dispose();
	services.length = 0;
	await rm(root, RM_TEMP);
});

describe("gh auth status parsing", () => {
	it("reads the login in both gh formats and leaves failed accounts out", () => {
		expect(loginFromAuthOutput("✓ Logged in to github.com account octocat (keyring)")).toBe("octocat");
		expect(loginFromAuthOutput("✓ Logged in to github.com as hubot (oauth_token)")).toBe("hubot");
		expect(
			accountsFromAuthOutput(
				[
					"github.com",
					"  ✓ Logged in to github.com account octocat (keyring)",
					"  - Active account: true",
					"  X Failed to log in to github.com account stale (keyring)",
					"  - Active account: false",
					"  ✓ Logged in to github.com account hubot (keyring)",
					"  - Active account: false",
				].join("\n"),
			),
		).toEqual([
			{ login: "octocat", active: true },
			{ login: "hubot", active: false },
		]);
	});
});

describe("GithubAuthService", () => {
	it("reports a signed-out gh with its version", async () => {
		const state = await service().refresh(true);
		expect(state.status).toEqual({
			installed: true,
			version: "2.62.0",
			authenticated: false,
			login: null,
			otherAccounts: [],
		});
		expect(state.identity).toEqual({ name: null, email: null });
	});

	it("falls back to plain `gh auth status` on a gh without --active", async () => {
		await seed([{ login: "octocat", id: 1, name: null, email: null }]);
		const state = await service({ FAKE_GH_OLD: "1" }).refresh(true);
		expect(state.status).toMatchObject({ version: "2.30.0", authenticated: true, login: "octocat" });
	});

	it("reports a missing gh without running anything", async () => {
		const created = new GithubAuthService({
			resolveGh: async () => null,
			resolveGit: async () => "git",
			run,
			pty: pipePty,
			loginEnv: async () => env,
			home: root,
			onState: () => {},
		});
		expect((await created.refresh(true)).status).toMatchObject({ installed: false, authenticated: false });
		expect((await created.startLogin()).flow).toEqual({ state: "failed", reason: "gh_missing" });
	});

	it("signs in by device code, holds gh's Enter until GitHub is opened, then fills only an empty identity", async () => {
		await run("git", ["config", "--global", "user.name", "Already Set"]);
		const auth = service();
		await auth.startLogin();
		expect(states.some(state => state.flow?.state === "starting")).toBe(true);
		await vi.waitFor(() => expect(auth.state().flow?.state).toBe("code"), { timeout: 10_000 });
		expect(auth.state().flow).toEqual({
			state: "code",
			code: "ABCD-1234",
			url: "https://github.com/login/device",
			opened: false,
		});
		// The Git-credentials question is answered on its own; "Press Enter to open" is not.
		expect(existsSync(`${env.FAKE_GH_STATE}.git-answered`)).toBe(true);
		expect(existsSync(`${env.FAKE_GH_STATE}.opened`)).toBe(false);

		expect(auth.openLogin().flow).toMatchObject({ state: "code", opened: true });
		await vi.waitFor(() => expect(auth.state().flow).toEqual({ state: "success", login: "octocat" }), {
			timeout: 10_000,
		});
		await vi.waitFor(() => expect(auth.state().busy).toBeNull(), { timeout: 10_000 });
		expect(auth.state().error).toBeNull();
		expect(auth.state().status).toMatchObject({ authenticated: true, login: "octocat" });
		expect(auth.state().identityFilled).toEqual(["email"]);
		expect(await gitConfig("user.name")).toBe("Already Set");
		expect(await gitConfig("user.email")).toBe("octocat@example.com");
		expect(auth.state().identity).toEqual({ name: "Already Set", email: "octocat@example.com" });
		// Nothing outside the temp HOME was touched.
		expect(await readFile(env.GIT_CONFIG_GLOBAL, "utf8")).toContain("octocat@example.com");
	});

	it("uses the noreply address when the account has no public email", async () => {
		const auth = service({ FAKE_GH_EMAIL: "none" });
		await auth.startLogin();
		await vi.waitFor(() => expect(auth.state().flow?.state).toBe("code"), { timeout: 10_000 });
		auth.openLogin();
		await vi.waitFor(() => expect(auth.state().identityFilled).toEqual(["name", "email"]), { timeout: 10_000 });
		expect(await gitConfig("user.name")).toBe("The Octocat");
		expect(await gitConfig("user.email")).toBe("583231+octocat@users.noreply.github.com");
	});

	it("switches between signed-in accounts and signs out the active one", async () => {
		await seed([
			{ login: "octocat", id: 1, name: null, email: null },
			{ login: "hubot", id: 2, name: null, email: null },
		]);
		const auth = service();
		expect((await auth.refresh(true)).status).toMatchObject({ login: "octocat", otherAccounts: ["hubot"] });

		const refused = await auth.switchAccount("nobody");
		expect(refused.error?.action).toBe("switch");
		expect(refused.status?.login).toBe("octocat");

		const switched = await auth.switchAccount("hubot");
		expect(switched.error).toBeNull();
		expect(switched.status).toMatchObject({ authenticated: true, login: "hubot", otherAccounts: ["octocat"] });

		// Two accounts: gh wants --user, which the service adds on its own.
		const out = await auth.logout();
		expect(out.error).toBeNull();
		expect(out.status).toMatchObject({ authenticated: true, login: "octocat", otherAccounts: [] });
		const gone = await auth.logout();
		expect(gone.status).toMatchObject({ authenticated: false, login: null });
	});

	it("ends a sign-in that outlives its code, and a cancel kills gh", async () => {
		const slow = service({ FAKE_GH_HANG: "1" }, 1);
		await slow.startLogin();
		await vi.waitFor(() => expect(slow.state().flow).toEqual({ state: "failed", reason: "timeout" }), {
			timeout: 10_000,
		});

		const auth = service({ FAKE_GH_HANG: "0" });
		await auth.startLogin();
		await vi.waitFor(() => expect(auth.state().flow?.state).toBe("code"), { timeout: 10_000 });
		expect(auth.cancelLogin().flow).toBeNull();
		expect(auth.state().status?.authenticated ?? false).toBe(false);
	});

	it("runs exactly gh's web device flow", () => {
		expect(LOGIN_ARGS).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
	});

	it("reads and sets the account's star on OMPdesk's repository, and says why when it can't", async () => {
		expect(await service().productStar(false)).toEqual({ starred: null, error: "not_signed_in" });
		await seed([{ login: "octocat", id: 1, name: null, email: null }]);
		const auth = service();
		await auth.refresh(true);
		expect(await auth.productStar(false)).toEqual({ starred: false, error: null });
		expect(await auth.productStar(true)).toEqual({ starred: true, error: null });
		const state = JSON.parse(await readFile(env.FAKE_GH_STATE, "utf8"));
		expect(state.accounts[0].starred).toEqual(["SeuPut0705/ompdesk"]);
		expect(await auth.productStar(false)).toEqual({ starred: true, error: null });
		const noGh = new GithubAuthService({
			resolveGh: async () => null,
			resolveGit: async () => "git",
			run,
			pty: pipePty,
			loginEnv: async () => env,
			home: root,
			onState: () => {},
		});
		services.push(noGh);
		expect(await noGh.productStar(true)).toEqual({ starred: null, error: "gh_missing" });
	});
});
