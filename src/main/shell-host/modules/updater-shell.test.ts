/**
 * The app updater (PROTOCOL.md §15.8) against the real shell: the cases of the TypeScript it replaced
 * (`updater-check.test.ts`, `update-auth.test.ts`, `update-provider.test.ts`, `nsis-updater.test.ts`) as Node sees
 * them, through `updater.*` answers, `updater.status` events and the `log.runtime` lines it sends. A local HTTP server stands in for GitHub
 * (`OMP_DEV_UPDATE_API`, an unpackaged shell only); the shell's files go under a temp folder (macOS `HOME`, Windows
 * `LOCALAPPDATA`), never the runner's own. macOS runs the manual mode (a relaunch needs a writable stand-in bundle),
 * Windows the automatic one.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UpdateAuthInfo, UpdateAuthTestResult } from "../../../shared/ipc-types";
import { type ModuleClient, shellModule } from "./client";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();

interface Status {
	state: string;
	version?: string;
	mode?: string;
	key?: string;
	suffix?: string;
	detail?: string;
	showInBanner?: boolean;
	reason?: string;
	notes?: string;
	percent?: number;
}

interface State {
	status: Status;
	installable: boolean;
	mode: string;
}

interface LogLine {
	message: string;
	details?: Record<string, unknown>;
}

type Spec = {
	calls: {
		start: { params: { version: string }; result: State };
		check: { params: Record<string, never>; result: State };
		download: { params: Record<string, never>; result: State };
		install: {
			params: { trigger: "auto" | "user click" | "quit" };
			result: { then: "quit" | "quit-for-update" | "none" };
		};
		authInfo: { params: Record<string, never>; result: UpdateAuthInfo };
		authTest: { params: { token?: string }; result: UpdateAuthTestResult };
	};
	posts: { quit: { trigger: "auto" | "user click" | "quit" } };
	events: { status: State };
	asks: { loginEnv: { params: Record<string, never>; result: { token?: string; path: string } } };
};

const ON_MAC = process.platform === "darwin";
const MODE = ON_MAC ? "manual" : "automatic";
/** Only Apple Silicon builds ship a DMG: an Intel Mac answers `unsupportedArchitecture` to any newer release. */
const CAN_DOWNLOAD = !ON_MAC || process.arch === "arm64";
const TIMEOUT = { timeout: 60_000 };
const HOOK_TIMEOUT = 30_000;

const API_PATH = "/repos/o/r";
const LATEST_PATH = `${API_PATH}/releases/latest`;
const ASSET_FILES = {
	mac: { id: 11, name: "ompdesk-mac-arm64.dmg" },
	windows: { id: 12, name: "ompdesk-windows-setup.exe" },
};
/** What this platform's update downloads: the asset the check picks and the file the shell leaves. */
const OWN_ASSET = ON_MAC ? ASSET_FILES.mac : ASSET_FILES.windows;

const PAYLOAD = Buffer.from(Array.from({ length: 65_536 }, (_, i) => (i * 7) % 251));
const sha512 = (bytes: Buffer | string): string => createHash("sha512").update(bytes).digest("base64");

/** Events in arrival order; `until` resolves once `count` of them match, whether they came before or after. */
class Feed<T> {
	readonly items: T[] = [];
	readonly #waiters: Array<() => void> = [];

	push(item: T): void {
		this.items.push(item);
		for (const wake of this.#waiters.splice(0)) wake();
	}

	async until(match: (item: T) => boolean, count = 1): Promise<T[]> {
		for (;;) {
			const found = this.items.filter(match);
			if (found.length >= count) return found;
			const woken = Promise.withResolvers<void>();
			this.#waiters.push(woken.resolve);
			await woken.promise;
		}
	}
}

interface Reply {
	status: number;
	json?: unknown;
	headers?: Record<string, string>;
}

interface Hit {
	path: string;
	authorization: string | undefined;
	range: string | undefined;
}

/** GitHub's release payload for `version`, its metadata comment naming `sha` as the installers' SHA-512. */
function releaseOf(
	origin: string,
	version: string,
	options: { body?: string; sha?: string; payload?: Buffer } = {},
): Reply {
	const payload = options.payload ?? PAYLOAD;
	const file = (name: string) => ({ name, size: payload.length, sha512: options.sha ?? sha512(payload) });
	const metadata = {
		version,
		releaseDate: "2026-01-02T03:04:05Z",
		files: { mac: file(ASSET_FILES.mac.name), windows: file(ASSET_FILES.windows.name) },
	};
	return {
		status: 200,
		json: {
			tag_name: `v${version}`,
			name: `v${version}`,
			body: options.body ?? `Notes.\n\n<!-- ompdesk-update ${JSON.stringify(metadata)} -->`,
			draft: false,
			prerelease: false,
			assets: Object.values(ASSET_FILES).map(({ id, name }) => ({
				id,
				name,
				size: payload.length,
				url: `${origin}${API_PATH}/releases/assets/${id}`,
			})),
		},
	};
}

/** The stand-in for GitHub: each endpoint answers from a field a test replaces; every request is recorded. */
interface Stand {
	readonly origin: string;
	readonly hits: Feed<Hit>;
	repo: (authorization: string | undefined) => Reply;
	latest: (authorization: string | undefined) => Reply | Promise<Reply>;
	/** The bytes the CDN serves for every asset (a release built with `releaseOf(…, {payload})` names the same). */
	payload: Buffer;
	hitsOf(path: string): Hit[];
	close(): Promise<void>;
}

function send(res: ServerResponse, reply: Reply): void {
	res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
	res.end(JSON.stringify(reply.json ?? {}));
}

async function startStand(): Promise<Stand> {
	const hits = new Feed<Hit>();
	const server = createServer((req, res) => void answer(req, res));
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const stand: Stand = {
		origin,
		hits,
		repo: () => ({ status: 200, json: {} }),
		latest: () => releaseOf(origin, "1.0.0"),
		payload: PAYLOAD,
		hitsOf: p => hits.items.filter(hit => hit.path === p),
		close() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			return closed.promise;
		},
	};

	async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const pathname = (req.url ?? "").split("?")[0] ?? "";
		const authorization = req.headers.authorization;
		hits.push({ path: pathname, authorization, range: req.headers.range });
		if (pathname === API_PATH) return send(res, stand.repo(authorization));
		if (pathname === LATEST_PATH) return send(res, await stand.latest(authorization));
		const asset = Object.values(ASSET_FILES).find(({ id }) => pathname === `${API_PATH}/releases/assets/${id}`);
		if (asset) {
			res.writeHead(302, { location: `${origin}/cdn/${asset.name}` });
			return void res.end();
		}
		if (pathname.startsWith("/cdn/")) {
			const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
			const from = range ? Number(range[1]) : 0;
			const payload = stand.payload;
			const body = payload.subarray(from);
			res.writeHead(range ? 206 : 200, {
				"content-type": "application/octet-stream",
				"content-length": body.length,
				...(range ? { "content-range": `bytes ${from}-${payload.length - 1}/${payload.length}` } : {}),
			});
			return void res.end(body);
		}
		send(res, { status: 404, json: { message: "Not Found" } });
	}

	return stand;
}

async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const saved = Object.keys(vars).map(name => [name, process.env[name]] as const);
	Object.assign(process.env, vars);
	try {
		return await run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
	}
}

interface Rig {
	readonly updater: ModuleClient<Spec>;
	readonly stand: Stand;
	readonly statuses: Feed<State>;
	readonly logs: Feed<LogLine>;
	/** What `updater.loginEnv` answers; undefined: no token in Node's environment. */
	token: string | undefined;
	/** macOS: where a manual installer lands. */
	readonly downloads: string;
	/** Windows: electron-updater's cache of the installer. */
	readonly pending: string;
	/** The shell's profile (`update-install.json` lands here). */
	readonly userData: string;
	/** Node's `app.exit`, then the shell's exit (its `shutdown` joins the install at quit); once. */
	close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, HOOK_TIMEOUT);

/** A shell on a private profile, `OMP_DEV_UPDATE_*` pointing at a fresh stand-in, its files under a temp folder. */
async function boot(extraEnv: Record<string, string> = {}): Promise<Rig> {
	if (!executable) throw new Error("no test shell");
	const root = mkdtempSync(path.join(tmpdir(), "oup-"));
	cleanups.push(async () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
	const home = path.join(root, "home");
	const localAppData = path.join(root, "local");
	const noTools = path.join(root, "bin");
	for (const dir of [home, localAppData, noTools]) mkdirSync(dir);
	const downloads = path.join(home, "Downloads");
	mkdirSync(downloads);

	const stand = await startStand();
	cleanups.push(() => stand.close());
	const env: Record<string, string> = {
		OMP_DEV_UPDATE_CHECK: "1",
		OMP_DEV_UPDATE_API: `${stand.origin}${API_PATH}`,
		OMP_GUI_HEADLESS: "1",
		...(ON_MAC ? { HOME: home, OMP_DEV_UPDATE_MODE: "manual" } : { LOCALAPPDATA: localAppData }),
		...extraEnv,
	};
	const shell: TestShell = await withEnv(env, () => startTestShell(executable));
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= shell.close();
		return closing;
	};
	cleanups.push(close);
	if (ON_MAC) expect(shell.facts.paths.downloads).toBe(downloads);

	const updater = shellModule<Spec>("updater", () => shell.client);
	const statuses = new Feed<State>();
	const logs = new Feed<LogLine>();
	updater.on("status", state => statuses.push(state));
	// The updater's lines reach Node as `log.runtime` (PROTOCOL.md §15.2), Node's to write.
	shell.client.on("log.runtime", ({ report }: { report: LogLine & { source?: string } }) => {
		if (report.source === "app-update") logs.push(report);
	});
	const rig: Rig = {
		updater,
		stand,
		statuses,
		logs,
		token: undefined,
		downloads,
		pending: path.join(localAppData, "ompdesk-updater", "pending"),
		userData: shell.facts.paths.userData,
		close,
	};
	// An empty folder as `PATH`: `gh auth token` is never found, whatever the runner has installed.
	updater.serve("loginEnv", () => ({ path: noTools, ...(rig.token ? { token: rig.token } : {}) }));
	return rig;
}

const isState = (name: string) => (item: State) => item.status.state === name;
const isLog = (message: string, event: string) => (line: LogLine) =>
	line.message === message && line.details?.event === event;
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
/** Everything that went to the log, as one text: where a token must never be. */
const logText = (rig: Rig): string => JSON.stringify(rig.logs.items);

/** The platform's way to fetch a found update: Windows downloads by itself, the manual macOS DMG waits for a click. */
async function downloadFound(rig: Rig): Promise<void> {
	await rig.statuses.until(isState("available"));
	if (ON_MAC) await rig.updater.call("download", {});
}

describe.skipIf(!executable)("the updater, in the real shell", () => {
	it("starts idle, installable false, in this platform's install mode", TIMEOUT, async () => {
		const { updater } = await boot();
		expect(await updater.call("start", { version: "1.0.0" })).toEqual({
			status: { state: "idle" },
			installable: false,
			mode: MODE,
		});
	});

	it("a repository with no release settles as no update", TIMEOUT, async () => {
		const rig = await boot();
		rig.stand.latest = () => ({ status: 404, json: { message: "Not Found" } });
		await rig.updater.call("start", { version: "1.0.0" });

		expect(await rig.updater.call("check", {})).toEqual({
			status: { state: "not-available", version: "1.0.0" },
			installable: false,
			mode: MODE,
		});
		const [line] = await rig.logs.until(isLog("check", "no-update"));
		expect(line?.details).toMatchObject({ current: "1.0.0", manual: true, note: "no release published" });
	});

	it("two checks at once make one release lookup and settle alike", TIMEOUT, async () => {
		const rig = await boot();
		const gate = Promise.withResolvers<void>();
		rig.stand.latest = async () => {
			await gate.promise;
			return releaseOf(rig.stand.origin, "1.0.0");
		};
		await rig.updater.call("start", { version: "1.0.0" });

		const first = rig.updater.call("check", {});
		const second = rig.updater.call("check", {});
		// Each check announces itself and the first one's lookup announces again: all three are in before the lookup answers.
		await rig.statuses.until(isState("checking"), 3);
		await rig.stand.hits.until(hit => hit.path === LATEST_PATH);
		gate.resolve();

		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(a.status).toEqual({ state: "not-available", version: "1.0.0" });
		expect(rig.stand.hitsOf(LATEST_PATH)).toHaveLength(1);
	});

	it("a release without its metadata comment is an error the banner shows", TIMEOUT, async () => {
		const rig = await boot();
		rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0", { body: "Notes only." });
		await rig.updater.call("start", { version: "1.0.0" });

		const settled = await rig.updater.call("check", {});
		expect(settled.status).toMatchObject({ state: "error", key: "updates.releaseInvalid", showInBanner: true });
		const [line] = await rig.logs.until(isLog("check", "error"));
		expect(line?.details).toMatchObject({ kind: "ERR_OMPDESK_UPDATE_METADATA" });
	});

	it("a private repository with no token asks for one", TIMEOUT, async () => {
		const rig = await boot();
		rig.stand.latest = () => ({ status: 404, json: { message: "Not Found" } });
		rig.stand.repo = () => ({ status: 404, json: { message: "Not Found" } });
		await rig.updater.call("start", { version: "1.0.0" });

		const settled = await rig.updater.call("check", {});
		expect(settled.status).toEqual({ state: "auth-required", reason: "missing" });
		const [line] = await rig.logs.until(isLog("check", "error"));
		expect(line?.details).toMatchObject({ kind: "auth-required:missing" });
	});

	it.skipIf(!CAN_DOWNLOAD)(
		"a token GitHub rejects is dropped and the check goes on anonymously",
		TIMEOUT,
		async () => {
			const rig = await boot();
			const token = "tok-secret-6";
			rig.token = token;
			rig.stand.repo = auth => (auth ? { status: 401, json: {} } : { status: 200, json: {} });
			rig.stand.latest = auth =>
				auth ? { status: 401, json: { message: "Bad credentials" } } : releaseOf(rig.stand.origin, "2.0.0");
			await rig.updater.call("start", { version: "1.0.0" });

			await rig.updater.call("check", {});
			const [found] = await rig.statuses.until(isState("available"));
			expect(found?.status).toMatchObject({ state: "available", version: "2.0.0", mode: MODE });
			if (!ON_MAC) await rig.statuses.until(isState("downloaded"));

			const lookups = rig.stand.hitsOf(LATEST_PATH).map(hit => hit.authorization);
			expect(lookups.slice(0, 2)).toEqual([`Bearer ${token}`, undefined]);
			expect(rig.stand.hitsOf(API_PATH).map(hit => hit.authorization)).toContain(`Bearer ${token}`);
			expect(logText(rig)).not.toContain(token);
		},
	);

	it.skipIf(!CAN_DOWNLOAD)(
		"a newer release downloads, verified, and the CDN never sees the token",
		TIMEOUT,
		async () => {
			const rig = await boot();
			const token = "tok-secret-7";
			rig.token = token;
			rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0");
			await rig.updater.call("start", { version: "1.0.0" });
			await rig.updater.call("check", {});
			await downloadFound(rig);

			const [done] = await rig.statuses.until(isState("downloaded"));
			expect(done).toEqual({
				status: { state: "downloaded", version: "2.0.0", mode: MODE },
				installable: !ON_MAC,
				mode: MODE,
			});
			const states = rig.statuses.items.map(item => item.status.state);
			expect(states.indexOf("available")).toBeLessThan(states.indexOf("downloaded"));

			const file = ON_MAC
				? path.join(rig.downloads, "ompdesk-2.0.0-arm64.dmg")
				: path.join(rig.pending, "ompdesk-windows-setup.exe");
			expect(readFileSync(file).equals(PAYLOAD)).toBe(true);
			expect(listing(path.dirname(file)).filter(name => name.endsWith(".partial"))).toEqual([]);

			const asset = rig.stand.hitsOf(`${API_PATH}/releases/assets/${OWN_ASSET.id}`);
			expect(asset.map(hit => hit.authorization)).toEqual([`Bearer ${token}`]);
			const cdn = rig.stand.hitsOf(`/cdn/${OWN_ASSET.name}`);
			expect(cdn).toHaveLength(1);
			expect(cdn[0]).toMatchObject({ authorization: undefined, range: undefined });
			await rig.logs.until(isLog("download", "started"));
			await rig.logs.until(isLog("download", "verified"));
			expect(logText(rig)).not.toContain(token);
		},
	);

	it.skipIf(!CAN_DOWNLOAD)("a download whose SHA-512 differs fails and leaves no file", TIMEOUT, async () => {
		const rig = await boot();
		rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0", { sha: sha512("something else") });
		await rig.updater.call("start", { version: "1.0.0" });
		await rig.updater.call("check", {});
		await downloadFound(rig);

		const [failed] = await rig.statuses.until(isState("error"));
		expect(failed?.status).toMatchObject({ state: "error", key: "updates.hashMismatch" });
		expect(listing(ON_MAC ? rig.downloads : rig.pending)).toEqual([]);
		const [line] = await rig.logs.until(isLog("download", "failed"));
		expect(line?.details).toMatchObject({ version: "2.0.0" });
	});

	it.skipIf(!CAN_DOWNLOAD)(
		"a downloaded version whose start failed is held: a check keeps it, a failed look keeps it, a newer one replaces it",
		TIMEOUT,
		async () => {
			const rig = await boot();
			// Node's record of 2.0.0 failing to start after an install (`rememberStartFailure`).
			writeFileSync(path.join(rig.userData, "update-start-failed.json"), '{"version":"2.0.0","count":1,"at":1}');
			rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0");
			await rig.updater.call("start", { version: "1.0.0" });
			await rig.updater.call("check", {});
			await downloadFound(rig);
			await rig.statuses.until(isState("downloaded"));
			const cdn = () => rig.stand.hitsOf(`/cdn/${OWN_ASSET.name}`).length;
			const fetched = cdn();
			const seen = rig.statuses.items.length;

			// Found again: still downloaded, fetched nothing, no "checking" over the held download.
			const again = await rig.updater.call("check", {});
			expect(again.status).toMatchObject({ state: "downloaded", version: "2.0.0" });
			expect(cdn()).toBe(fetched);
			// A failed look keeps it as well, and says so in the log.
			rig.stand.latest = () => ({ status: 500, json: { message: "down" } });
			const failed = await rig.updater.call("check", {});
			expect(failed.status).toMatchObject({ state: "downloaded", version: "2.0.0" });
			const [held] = await rig.logs.until(line => line.message === "check" && line.details?.kind === "held");
			expect(held?.details).toMatchObject({ event: "error", manual: true });
			expect(rig.statuses.items.slice(seen)).toEqual([]);

			// A newer release is what the rolled-back app waits for: it is fetched and replaces the held one.
			rig.stand.latest = () => releaseOf(rig.stand.origin, "2.1.0");
			await rig.updater.call("check", {});
			await downloadFound(rig);
			const [newer] = await rig.statuses.until(
				item => isState("downloaded")(item) && item.status.version === "2.1.0",
			);
			expect(newer?.status).toMatchObject({ state: "downloaded", version: "2.1.0" });
			expect(cdn()).toBe(fetched + 1);
		},
	);

	it.skipIf(!CAN_DOWNLOAD)("a partial file resumes with a range request and still verifies", TIMEOUT, async () => {
		const rig = await boot();
		rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0");
		const half = PAYLOAD.length / 2;
		const partial = ON_MAC
			? path.join(rig.downloads, "ompdesk-2.0.0-arm64.dmg.partial")
			: path.join(rig.pending, "ompdesk-windows-setup.exe.partial");
		mkdirSync(path.dirname(partial), { recursive: true });
		writeFileSync(partial, PAYLOAD.subarray(0, half));
		await rig.updater.call("start", { version: "1.0.0" });
		await rig.updater.call("check", {});
		await downloadFound(rig);

		await rig.statuses.until(isState("downloaded"));
		const cdn = rig.stand.hitsOf(`/cdn/${OWN_ASSET.name}`);
		expect(cdn.map(hit => hit.range)).toEqual([`bytes=${half}-`]);
		expect(readFileSync(partial.replace(/\.partial$/, "")).equals(PAYLOAD)).toBe(true);
		expect(existsSync(partial)).toBe(false);
	});

	it("tests a token against the repository and reports what is stored", TIMEOUT, async () => {
		const rig = await boot();
		const { updater, stand } = rig;
		expect(await updater.call("authInfo", {})).toEqual({
			source: null,
			hasStoredToken: false,
			canStore: true,
			droppedReason: null,
		});

		const probes: Array<[Reply, UpdateAuthTestResult["access"]]> = [
			[{ status: 401 }, "invalid"],
			[{ status: 403, headers: { "x-ratelimit-remaining": "0" } }, "network"],
			[{ status: 404 }, "denied"],
			[{ status: 200 }, "ok"],
		];
		for (const [reply, access] of probes) {
			stand.repo = () => reply;
			expect(await updater.call("authTest", { token: "t" })).toEqual({ access, source: null });
		}

		// No token given: the one the next check would use, or "missing" when the repo refuses an anonymous probe.
		stand.repo = () => ({ status: 404 });
		expect(await updater.call("authTest", {})).toEqual({ access: "missing", source: null });
		rig.token = "from-env";
		stand.repo = () => ({ status: 200 });
		expect(await updater.call("authTest", {})).toEqual({ access: "ok", source: "env" });
	});

	it.skipIf(process.platform !== "win32")("the dev dry install is installable and quits", TIMEOUT, async () => {
		const rig = await boot({ OMP_DEV_UPDATE_STAGED: "x", OMP_DEV_UPDATE_STAGED_VERSION: "9.9.9" });

		expect(await rig.updater.call("start", { version: "1.0.0" })).toEqual({
			status: { state: "downloaded", version: "9.9.9", mode: "automatic" },
			installable: true,
			mode: "automatic",
		});
		const installed = await rig.updater.call("install", { trigger: "user click" });
		expect(installed.then).toBe("quit");
	});

	// The installer the shell starts is a real process (was installer-spawn.test.ts and nsis-updater.test.ts): the stand
	// serves a recorder as the setup, a program this suite compiles with the runner's rustc (GitHub's Windows images
	// carry Rust) that writes the arguments it was started with beside itself and ends.
	describe.skipIf(process.platform !== "win32")("the Windows installer, a real process", () => {
		const RECORD = "installer-args.txt";
		let recorder: Buffer;
		let built: string;

		beforeAll(() => {
			built = mkdtempSync(path.join(tmpdir(), "oup-recorder-"));
			const source = path.join(built, "recorder.rs");
			writeFileSync(
				source,
				`fn main() {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let out = std::env::current_exe().unwrap().with_file_name("${RECORD}");
	let part = out.with_extension("part");
	std::fs::write(&part, args.join("\\n") + "\\n").unwrap();
	std::fs::rename(&part, &out).unwrap();
}
`,
			);
			const exe = path.join(built, "recorder.exe");
			execFileSync("rustc", ["-O", "-o", exe, source], { cwd: built, stdio: "pipe" });
			recorder = readFileSync(exe);
		}, 120_000);
		afterAll(() => rmSync(built, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

		/** The arguments the recorder was started with, once its record appears (it runs detached; its rename is atomic). */
		function startedWith(rig: Rig): Promise<string[]> {
			const file = path.join(rig.pending, RECORD);
			return new Promise((resolve, reject) => {
				const watcher = watch(rig.pending);
				cleanups.push(async () => watcher.close());
				const settle = (): void => {
					if (!existsSync(file)) return;
					watcher.close();
					resolve(readFileSync(file, "utf8").trimEnd().split("\n"));
				};
				watcher.on("change", settle);
				watcher.on("error", error => {
					watcher.close();
					reject(error);
				});
				// Registered first, then looked: a record written before the watch began is found here.
				settle();
			});
		}

		/** Finds 2.0.0, its "installer" `payload`, and downloads it by itself (automatic mode). */
		async function downloaded(payload: Buffer): Promise<Rig> {
			const rig = await boot();
			rig.stand.payload = payload;
			rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0", { payload });
			await rig.updater.call("start", { version: "1.0.0" });
			await rig.updater.call("check", {});
			await rig.statuses.until(item => item.status.state === "downloaded" && item.installable);
			expect(readFileSync(path.join(rig.pending, ASSET_FILES.windows.name)).equals(payload)).toBe(true);
			return rig;
		}

		const marker = (rig: Rig): Record<string, unknown> =>
			JSON.parse(readFileSync(path.join(rig.userData, "update-install.json"), "utf8"));

		it("Restart & install starts the downloaded installer, then Node quits for the update", TIMEOUT, async () => {
			const rig = await downloaded(recorder);
			const installed = await rig.updater.call("install", { trigger: "user click" });
			expect(installed.then).toBe("quit-for-update");
			// Started: no failure status after the install, and the marker says which install began.
			expect(rig.statuses.items.some(isState("error"))).toBe(false);
			expect(marker(rig)).toMatchObject({ from: "1.0.0", to: "2.0.0", mode: "nsis", trigger: "user click" });
			await rig.logs.until(isLog("swap", "helper"));
			expect(await startedWith(rig)).toEqual(["--updated", "--force-run"]);
		});

		it("an installer Windows refuses to run fails the install, and Node still quits", TIMEOUT, async () => {
			const rig = await downloaded(Buffer.from("MZ, but no program at all"));
			const installed = await rig.updater.call("install", { trigger: "user click" });
			// As electron-updater: the quit follows the attempt, started or not; the failure reaches the status.
			expect(installed.then).toBe("quit-for-update");
			const [failed] = await rig.statuses.until(isState("error"));
			expect(failed?.status).toMatchObject({ state: "error", key: "updates.failed" });
		});

		it("an approved quit starts the installer silently as the shell ends", TIMEOUT, async () => {
			const rig = await downloaded(recorder);
			await rig.updater.post("quit", { trigger: "quit" });
			await rig.logs.until(isLog("swap", "helper"));
			// Read before the close: the harness removes the private profile once the shell has exited.
			expect(marker(rig)).toMatchObject({ to: "2.0.0", mode: "nsis", trigger: "quit" });
			await rig.close();
			// The recorder lives in the installer cache, outside the profile: its record outlives the shell.
			expect(await startedWith(rig)).toEqual(["--updated", "/S"]);
		});

		it("an approved quit installs nothing of a version whose start failed", TIMEOUT, async () => {
			const rig = await boot();
			writeFileSync(path.join(rig.userData, "update-start-failed.json"), '{"version":"2.0.0","count":1,"at":1}');
			rig.stand.payload = recorder;
			rig.stand.latest = () => releaseOf(rig.stand.origin, "2.0.0", { payload: recorder });
			await rig.updater.call("start", { version: "1.0.0" });
			await rig.updater.call("check", {});
			await rig.statuses.until(item => item.status.state === "downloaded" && item.installable);
			await rig.updater.post("quit", { trigger: "quit" });
			const [skipped] = await rig.logs.until(isLog("swap", "skipped"));
			expect(skipped?.details).toMatchObject({ reason: "start failed before", version: "2.0.0" });
			expect(rig.logs.items.some(isLog("swap", "helper"))).toBe(false);
			expect(existsSync(path.join(rig.userData, "update-install.json"))).toBe(false);
			await rig.close();
			expect(existsSync(path.join(rig.pending, RECORD))).toBe(false);
		});
	});
});
