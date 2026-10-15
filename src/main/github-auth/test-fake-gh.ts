/**
 * Test-only fake GitHub CLI: gh's status/login/logout/switch/api output and
 * prompts, with its accounts in the JSON file `$FAKE_GH_STATE`. Never touches
 * the user's gh config. Shared by the unit tests and e2e/github-sign-in.e2e.ts.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeGhAccount {
	login: string;
	id: number;
	name: string | null;
	email: string | null;
}

/**
 * Write the fake as `<dir>/fake-gh/gh`, a bun script with a shebang: on POSIX
 * that directory works as a PATH entry (e2e); unit tests run it as `bun <path>`
 * on every platform. Returns its path.
 */
export async function writeFakeGh(dir: string): Promise<string> {
	const binDir = join(dir, "fake-gh");
	await mkdir(binDir, { recursive: true });
	const bin = join(binDir, "gh");
	await writeFile(bin, `#!/usr/bin/env bun\n${FAKE_GH}`);
	await chmod(bin, 0o755);
	return bin;
}

/** Seed `$FAKE_GH_STATE`: the first account is the active one. */
export async function seedFakeGh(stateFile: string, accounts: FakeGhAccount[]): Promise<void> {
	await writeFile(stateFile, JSON.stringify({ accounts, active: accounts[0]?.login ?? null }));
}

/** The fake gh: state in $FAKE_GH_STATE ({accounts, active}); $FAKE_GH_OLD=1 is gh < 2.40. */
const FAKE_GH = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const file = process.env.FAKE_GH_STATE;
const old = process.env.FAKE_GH_OLD === "1";
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = state => writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [group, verb] = args;
const state = load();
if (group === "--version") { console.log("gh version " + (old ? "2.30.0" : "2.62.0") + " (2024-11-14)"); process.exit(0); }
if (group === "auth" && verb === "status") {
	if (args.includes("--active") && old) { console.error("unknown flag: --active"); process.exit(1); }
	if (!state.active) { console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login"); process.exit(1); }
	const shown = args.includes("--active") ? state.accounts.filter(a => a.login === state.active) : state.accounts;
	const lines = ["github.com"];
	for (const a of shown) {
		if (old) lines.push("  ✓ Logged in to github.com as " + a.login + " (oauth_token)");
		else lines.push("  ✓ Logged in to github.com account " + a.login + " (keyring)", "  - Active account: " + (a.login === state.active));
	}
	if (!args.includes("--active")) lines.push("  X Failed to log in to github.com account stale (keyring)", "  - Active account: false");
	console.log(lines.join("\\n"));
	process.exit(0);
}
if (group === "auth" && verb === "login") {
	const lines = createInterface({ input: process.stdin });
	const next = () => { const { promise, resolve } = Promise.withResolvers(); lines.once("line", resolve); return promise; };
	process.stdout.write("? Authenticate Git with your GitHub credentials? (Y/n) ");
	await next();
	writeFileSync(file + ".git-answered", "");
	if (process.env.FAKE_GH_HANG === "1") await Promise.withResolvers().promise;
	process.stdout.write("\\n\\u001b[0;33m!\\u001b[0m First copy your one-time code: \\u001b[1mABCD-1234\\u001b[0m\\n");
	process.stdout.write("Press Enter to open https://github.com/login/device in your browser... ");
	await next();
	writeFileSync(file + ".opened", "");
	const login = process.env.FAKE_GH_LOGIN_AS || "octocat";
	const s = load();
	if (!s.accounts.some(a => a.login === login)) s.accounts.push({ login, id: login === "octocat" ? 583231 : 9919, name: login === "octocat" ? "The Octocat" : null, email: process.env.FAKE_GH_EMAIL === "none" ? null : login + "@example.com" });
	s.active = login;
	save(s);
	console.log("✓ Authentication complete.");
	process.exit(0);
}
if (group === "auth" && verb === "logout") {
	const user = flag("--user");
	if (!user && state.accounts.length > 1) { console.error("multiple accounts; specify --user"); process.exit(1); }
	const login = user || state.active;
	state.accounts = state.accounts.filter(a => a.login !== login);
	state.active = state.accounts[0]?.login ?? null;
	save(state);
	process.exit(0);
}
if (group === "auth" && verb === "switch") {
	const user = flag("--user");
	if (!state.accounts.some(a => a.login === user)) { console.error("not logged in as " + user); process.exit(1); }
	state.active = user;
	save(state);
	process.exit(0);
}
if (group === "api" && verb === "user") {
	const a = state.accounts.find(x => x.login === state.active);
	if (!a) { console.error("HTTP 401"); process.exit(1); }
	console.log(JSON.stringify({ login: a.login, id: a.id, name: a.name, email: a.email }));
	process.exit(0);
}
// GET / PUT user/starred/<owner>/<repo>: 204 (silent) when starred, gh's 404 message when not.
const starPath = args.find(a => a.startsWith("user/starred/"));
if (group === "api" && starPath) {
	const a = state.accounts.find(x => x.login === state.active);
	if (!a) { console.error("HTTP 401"); process.exit(1); }
	const repo = starPath.slice("user/starred/".length);
	a.starred = a.starred ?? [];
	if (flag("--method") === "PUT") {
		if (!a.starred.includes(repo)) a.starred.push(repo);
		save(state);
		process.exit(0);
	}
	if (a.starred.includes(repo)) process.exit(0);
	console.error("gh: Not Found (HTTP 404)");
	process.exit(1);
}
console.error("fake gh: unsupported " + args.join(" "));
process.exit(2);
`;
