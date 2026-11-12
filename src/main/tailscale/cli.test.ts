/**
 * The CLI's client against the real core process, with node standing in for `tailscale` so the file runs on every
 * platform: how a run that fails, cannot start or is cut short is reported, the environment a run gets, and the two
 * things main still decides by itself (which sign-in link may be opened, how the app is started).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTailscaleApp, TailscaleCli } from "./cli";
import type { LocatedTailscale } from "./locate";
import { answer, defaultTailscaleScenario, fakeTailscaleCli } from "./test-fake-tailscale";

const dir = mkdtempSync(join(tmpdir(), "omp-gui-tailscale-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let scripts = 0;

/**
 * A CLI that is node running `code` before anything else (a `--require` script, so the CLI's own arguments are
 * never read as a script to run). `code` sees them as `args` and ends the process itself. Node spells its first
 * argument as a path by then: its last part is the argument.
 */
function standIn(code: string): TailscaleCli {
	const script = join(dir, `stand-in-${++scripts}.cjs`);
	writeFileSync(
		script,
		`const fs = require("node:fs");\nconst args = [require("node:path").basename(process.argv[1] ?? ""), ...process.argv.slice(2)];\n${code}\n`,
	);
	const located: LocatedTailscale = {
		path: process.execPath,
		variant: "mac-cli",
		app: null,
		env: { NODE_OPTIONS: `--require ${JSON.stringify(script)}`, TAILSCALE_BE_CLI: "1" },
	};
	return new TailscaleCli(located);
}

/** Blocks the stand-in (no event loop needed) until it is ended from outside. */
const HANG = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);";

describe("the tailscale CLI through the core", () => {
	it("reads a status whatever the exit code, and says what a failing CLI said", async () => {
		const doc = answer(["status", "--json"], defaultTailscaleScenario({ httpsEnabled: false })).stdout;
		const printed = standIn(`fs.writeSync(1, ${JSON.stringify(doc)}); process.exit(0);`);
		const read = await printed.status();
		expect(read).toMatchObject({ code: 0, spawnError: null, line: "{" });
		expect(read.status).toMatchObject({ backend: "running", login: "seuput@example.com", phones: ["iphone"] });
		expect(read.httpsProblem).toBe("HTTPS certificates are not enabled for this tailnet");

		const failing = standIn(
			`fs.writeSync(1, ${JSON.stringify(doc)}); fs.writeSync(2, "\\n  warned  \\nmore\\n"); process.exit(3);`,
		);
		expect(await failing.status()).toMatchObject({ code: 3, line: "warned", status: { backend: "running" } });

		const down = standIn(
			`fs.writeSync(2, "failed to connect to local Tailscale service; is Tailscale running?\\n"); process.exit(1);`,
		);
		expect(await down.status()).toEqual({
			code: 1,
			spawnError: null,
			line: "failed to connect to local Tailscale service; is Tailscale running?",
			status: null,
			httpsProblem: null,
		});
		expect(await standIn("process.exit(1);").status()).toMatchObject({ code: 1, line: null, status: null });
	});

	it("gives a run main's environment with the located CLI's own over it, and its arguments as written", async () => {
		process.env.OMP_GUI_TEST_TAILSCALE_MARK = "from main";
		try {
			const echo = standIn(
				`fs.writeSync(2, JSON.stringify([args, process.env.TAILSCALE_BE_CLI, process.env.OMP_GUI_TEST_TAILSCALE_MARK])); process.exit(1);`,
			);
			const read = await echo.status();
			expect(JSON.parse(read.line ?? "")).toEqual([["status", "--json"], "1", "from main"]);
		} finally {
			delete process.env.OMP_GUI_TEST_TAILSCALE_MARK;
		}
	});

	it("reports a CLI that is not there as node did: no exit code, ENOENT", async () => {
		const missing = join(dir, "no-such-tailscale");
		const cli = new TailscaleCli({ path: missing, variant: "mac-cli", app: null, env: {} });
		expect(await cli.status()).toEqual({
			code: null,
			spawnError: "ENOENT",
			line: `spawn ${missing} ENOENT`,
			status: null,
			httpsProblem: null,
		});
		expect(await cli.whois("100.64.0.9")).toBeNull();
		expect(await cli.version(15_000)).toBeNull();
		expect(await cli.unpublish({ host: "h", port: 47831, target: "http://127.0.0.1:1" }, "s")).toEqual({
			kind: "failed",
			detail: `spawn ${missing} ENOENT`,
			off: false,
		});
		// No record: nothing is asked of the CLI at all.
		expect(await cli.unpublish(undefined, "s")).toEqual({ kind: "none" });
	});

	it("keeps what an `up --json` printed before it was cut short, and finds the link in a plain `up`", async () => {
		const waiting = standIn(
			`fs.writeSync(1, '{"BackendState":"NeedsLogin"}\\n{"AuthURL":"https://login.tailscale.com/a/1"}\\n{"Auth'); ${HANG}`,
		);
		const cut = await waiting.up(true, 500);
		expect(cut).toMatchObject({ code: null, authUrl: "https://login.tailscale.com/a/1" });
		// Nothing on stderr: node's own words for a command that was ended stand in.
		expect(cut.line).toBe(`Command failed: ${process.execPath} up --json`);

		const plain = standIn(
			`fs.writeSync(2, "\\nTo authenticate, visit:\\n\\n\\thttps://login.tailscale.com/a/2\\n\\n"); process.exit(0);`,
		);
		expect(await plain.up(false)).toEqual({
			code: 0,
			line: "To authenticate, visit:",
			authUrl: null,
			loginUrl: "https://login.tailscale.com/a/2",
		});
	});

	it("reads the version, the control server's host and a whois answer only from a call that succeeded", async () => {
		const version = standIn(`fs.writeSync(1, "1.104.1\\n  tailscale commit: fake\\n"); process.exit(0);`);
		expect(await version.version(15_000)).toBe("1.104.1");
		expect(await standIn(`fs.writeSync(1, "1.104.1\\n"); process.exit(2);`).version(15_000)).toBeNull();
		const prefs = standIn(`fs.writeSync(1, '{"ControlURL":"https://hs.example.org:8080"}'); process.exit(0);`);
		expect(await prefs.controlHost()).toBe("hs.example.org");
		const whois = standIn(
			`fs.writeSync(1, JSON.stringify({ Node: { StableID: "nA", ComputedName: args.join(" ") }, UserProfile: { LoginName: "a@b.c" } })); process.exit(0);`,
		);
		expect(await whois.whois("fd7a:115c:a1e0::9")).toEqual({
			nodeId: "nA",
			nodeName: "whois --json fd7a:115c:a1e0::9",
			login: "a@b.c",
		});
	});
});

describe("starting the Tailscale app", () => {
	it("runs a test's stand-in instead, and says what it said when it fails", async () => {
		const calls: string[][] = [];
		const fake = await fakeTailscaleCli(defaultTailscaleScenario(), calls)();
		const located: LocatedTailscale = {
			path: "/no/such/tailscale",
			variant: "mac-standalone",
			app: "/No.app",
			env: {},
		};
		// The fake answers a call without a command with exit 1.
		expect(await startTailscaleApp(located, "darwin", fake.path)).toEqual({
			code: 1,
			line: "fake-tailscale: unsupported command:",
		});
		expect(calls).toEqual([[]]);
	});

	it("says so for a Mac's Tailscale that has no app", async () => {
		const located: LocatedTailscale = { path: "/usr/local/bin/tailscale", variant: "mac-cli", app: null, env: {} };
		expect(await startTailscaleApp(located, "darwin", null)).toEqual({
			code: 1,
			line: "This Tailscale has no app to start: start its daemon (tailscaled) yourself",
		});
	});
});
