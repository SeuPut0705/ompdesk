import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { binaryFile, ensureNative } from "../../../scripts/build-native";
import { TOKEN_FILE } from "../../shared/control-protocol";
import type { ToolOutcome } from "../agent-control/service";
import type { TabActivity } from "../sidecar-pool";
import type { ControlBackend, OutsideCaller, SessionView } from "./backend";
import { type ControlSocketHandle, startControlSocket } from "./index";

// The `ompdesk` CLI (Rust, native/ompdesk/crates/cli) against main's own control socket: what a script sees (output,
// exit code) and what main receives. The command table, flag parsing and the event stream are tested in the crate.

class Backend implements ControlBackend {
	readonly calls: { caller: OutsideCaller; tool: string; args: unknown }[] = [];
	failing = false;

	async run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome> {
		this.calls.push({ caller, tool, args });
		return { text: `ran ${tool} ${JSON.stringify(args)}`, isError: this.failing };
	}
	async resolve(): Promise<SessionView> {
		throw new Error("no such session");
	}
	view(): SessionView | null {
		return null;
	}
	views(): SessionView[] {
		return [];
	}
	observe(_listener: (activity: TabActivity) => void): () => void {
		return () => undefined;
	}
	onOutsideMail(): () => void {
		return () => undefined;
	}
	release(): void {}
}

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let binary: string;
beforeAll(() => {
	// A stale or missing build compiles here; a fresh one only hashes the sources.
	binary = join(ensureNative(), binaryFile("ompdesk"));
}, 600_000);

describe("ompdesk CLI", () => {
	let userData: string;
	let handle: ControlSocketHandle | undefined;
	let backend: Backend;

	beforeEach(() => {
		userData = mkdtempSync(join(tmpdir(), "ompdesk-cli-"));
		backend = new Backend();
	});
	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(userData, { recursive: true, force: true });
	});

	async function start(): Promise<ControlSocketHandle> {
		handle = (await startControlSocket({ userData, backend })) ?? undefined;
		if (!handle) throw new Error("control socket did not start");
		return handle;
	}

	/** `ompdesk <args>` as a shell outside OMPdesk runs it, finding the app through `dir`. */
	function ompdesk(dir: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) {
		const env: NodeJS.ProcessEnv = { ...process.env, OMPDESK_CONTROL_DIR: dir, ...options.env };
		// A test run from inside an OMPdesk session must never reach that app.
		for (const name of ["OMPDESK_SOCKET", "OMPDESK_CALLER", "OMPDESK_CONTROL_OFF"])
			if (options.env?.[name] === undefined) delete env[name];
		const { promise, resolve, reject } = Promise.withResolvers<Run>();
		const child = spawn(binary, args, { env, cwd: userData, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (text: string) => {
			stdout += text;
		});
		child.stderr.setEncoding("utf8").on("data", (text: string) => {
			stderr += text;
		});
		child.on("error", reject);
		child.on("close", code => resolve({ code, stdout, stderr }));
		child.stdin.end(options.stdin ?? "");
		return promise;
	}

	it("runs a tool as the named caller from its folder and prints the tool's text", async () => {
		const { dir } = await start();
		const run = await ompdesk(dir, ["sessions", "--scope", "app", "--limit", "5"], {
			env: { OMPDESK_CALLER: "ci" },
		});
		expect(run).toEqual({ code: 0, stdout: 'ran ompdesk_sessions {"scope":"app","limit":5}\n', stderr: "" });
		expect(backend.calls).toEqual([
			{
				caller: {
					id: expect.stringMatching(/^outside:ci#\d+$/),
					name: "ci",
					title: 'outside process "ci" (self-declared)',
					cwd: realpathSync(userData),
				},
				tool: "ompdesk_sessions",
				args: { scope: "app", limit: 5 },
			},
		]);
	});

	it("reads a message from stdin for `-`, keeping what a person typed", async () => {
		const { dir } = await start();
		const run = await ompdesk(dir, ["open", "-", "--folder", "/x"], { stdin: '첫 줄 "quoted"\n둘째 줄 🙂\n' });
		expect(run.code).toBe(0);
		expect(backend.calls[0]?.args).toEqual({ message: '첫 줄 "quoted"\n둘째 줄 🙂', folder: "/x" });
	});

	it("prints the raw result with --json", async () => {
		const { dir } = await start();
		const run = await ompdesk(dir, ["merge", "a", "--json"]);
		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({ text: 'ran ompdesk_merge {"session":"a"}', isError: false });
	});

	it("exits 1 when the tool reports a failure, its text on stderr", async () => {
		const { dir } = await start();
		backend.failing = true;
		const run = await ompdesk(dir, ["merge", "x"]);
		expect(run).toEqual({ code: 1, stdout: "", stderr: 'ompdesk: ran ompdesk_merge {"session":"x"}\n' });
	});

	it("exits 1 on main's error response, with --json showing it", async () => {
		const { dir } = await start();
		const run = await ompdesk(dir, ["state", "nope", "--json"]);
		expect(run.code).toBe(1);
		expect(JSON.parse(run.stdout)).toEqual({
			ok: false,
			error: { code: "session_not_found", message: "no such session" },
		});
		expect(run.stderr).toBe("ompdesk: session_not_found: no such session\n");
	});

	it("exits 3 when main refuses its token", async () => {
		const { dir } = await start();
		writeFileSync(join(dir, TOKEN_FILE), "not-the-token\n", { mode: 0o600 });
		const run = await ompdesk(dir, ["sessions"]);
		expect(run.code).toBe(3);
		expect(run.stderr).toContain("unauthorized");
		expect(backend.calls).toEqual([]);
	});

	it("exits 3 when OMPdesk is not running", async () => {
		const run = await ompdesk(userData, ["sessions"]);
		expect(run.code).toBe(3);
		expect(run.stderr).toContain("not running");
	});

	it("refuses to run in a session OMPdesk hosts for another device", async () => {
		const { dir } = await start();
		const run = await ompdesk(dir, ["sessions"], { env: { OMPDESK_CONTROL_OFF: "1" } });
		expect(run.code).toBe(3);
		expect(run.stderr).toContain("another device");
		expect(backend.calls).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"never uses a socket, a folder or a token that is not this user's alone",
		async () => {
			const { dir, socket } = await start();
			const cases: [string, string, number, number][] = [
				["socket open to others", socket, 0o666, 0o600],
				["folder open to others", dirname(socket), 0o755, 0o700],
				["token open to others", join(dir, TOKEN_FILE), 0o644, 0o600],
			];
			for (const [what, path, loose, tight] of cases) {
				chmodSync(path, loose);
				const run = await ompdesk(dir, ["sessions"]);
				chmodSync(path, tight);
				expect(run.code, what).toBe(3);
				expect(run.stderr, what).toContain("refused");
			}
			expect(backend.calls).toEqual([]);
			expect((await ompdesk(dir, ["sessions"])).code).toBe(0);
		},
	);

	it("exits 2 on a usage error and 0 on help, without OMPdesk", async () => {
		const usage = await ompdesk(userData, ["send", "only-session"]);
		expect(usage.code).toBe(2);
		expect(usage.stderr).toContain("Run `ompdesk help` for the commands.");
		const help = await ompdesk(userData, ["help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("Exit codes");
	});
});
