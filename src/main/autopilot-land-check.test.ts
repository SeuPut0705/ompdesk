import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkExcerpt, checkLandCandidate, pointCommandAt } from "./autopilot-land-check";
import { gitSync, initRepo } from "./local/git/test-repos";
import { resetLoginShellEnvCache } from "./shell-env";

describe("checkLandCandidate", () => {
	const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
	afterEach(() => {
		process.env.PATH = saved.PATH;
		process.env.SHELL = saved.SHELL;
		resetLoginShellEnvCache();
	});

	// The land waits on this: a check that outlives its bound is stopped and reported timed out, never waited for.
	it.skipIf(process.platform === "win32")("stops a check that outlives its timeout", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-land-timeout-"));
		try {
			await initRepo(dir);
			const sha = gitSync(dir, "rev-parse", "HEAD").trim();
			const started = Date.now();
			const result = await checkLandCandidate({ root: dir, primary: dir, sha, command: "sleep 60", timeoutMs: 400 });
			expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
			expect(Date.now() - started).toBeLessThan(30_000);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	// A Finder-launched app has launchd's bare PATH; the cycle's command ran in the session's bash, whose PATH is the
	// login shell's (shellSpawnEnv), so `bun run check` passed there and must find `bun` here too.
	it.skipIf(process.platform === "win32")(
		"runs the command with the login shell's PATH, as the session did",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-land-path-"));
			try {
				const tools = path.join(dir, "tools");
				await fs.mkdir(tools);
				await fs.writeFile(path.join(tools, "landtool"), "#!/bin/sh\necho landtool-ran\n", { mode: 0o755 });
				const shell = path.join(dir, "fake-shell");
				await fs.writeFile(
					shell,
					`#!/bin/sh\nprintf '%s\\n' __OMP_ENV_BEGIN__ 'PATH=${tools}:/usr/bin:/bin' __OMP_ENV_END__\n`,
					{ mode: 0o755 },
				);
				const repo = path.join(dir, "repo");
				await fs.mkdir(repo);
				await initRepo(repo);
				const sha = gitSync(repo, "rev-parse", "HEAD").trim();
				process.env.SHELL = shell;
				process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
				resetLoginShellEnvCache();
				const result = await checkLandCandidate({ root: repo, primary: repo, sha, command: "landtool" });
				expect(result.tail).toContain("landtool-ran");
				expect(result.ok).toBe(true);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps the first error of a long failing output, not only its last lines",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-land-tail-"));
			try {
				const repo = path.join(dir, "repo");
				await fs.mkdir(repo);
				await initRepo(repo);
				const sha = gitSync(repo, "rev-parse", "HEAD").trim();
				const command =
					"echo 'TypeError: (0 , act) is not a function'; echo '    at mount (a.test.tsx:12:3)'; " +
					'for i in $(seq 1 200); do echo " FAIL  |renderer| src/f$i.test.tsx [ src/f$i.test.tsx ]"; done; exit 1';
				const result = await checkLandCandidate({ root: repo, primary: repo, sha, command });
				expect(result.ok).toBe(false);
				expect(result.tail).toContain("TypeError: (0 , act) is not a function");
				expect(result.tail).toContain("src/f200.test.tsx");
				expect(result.tail.length).toBeLessThanOrEqual(2_000);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("checkExcerpt", () => {
	it("finds a colored error (vitest under FORCE_COLOR) and drops the color codes", () => {
		const failing = Array.from({ length: 200 }, (_, i) => `\u001b[31m FAIL \u001b[39m src/f${i}.test.tsx`).join("\n");
		const output = `\u001b[31m\u001b[1mTypeError\u001b[22m: (0 , act) is not a function\u001b[39m\n    at mount (a.test.tsx:12:3)\n${failing}`;
		const excerpt = checkExcerpt(output);
		expect(excerpt).toContain("TypeError: (0 , act) is not a function");
		expect(excerpt).toContain("src/f199.test.tsx");
		expect(excerpt).not.toContain("\u001b[");
		expect(excerpt.length).toBeLessThanOrEqual(2_000);
	});
});

describe("pointCommandAt", () => {
	const root = "C:\\Users\\me\\.omp\\wt\\run";
	const tree = "C:\\Temp\\land\\tree";

	it.each([
		["forward slashes", "cd C:/Users/me/.omp/wt/run && bun test", "cd C:/Temp/land/tree && bun test"],
		["Git Bash's drive form", "cd /c/Users/me/.omp/wt/run/src && ls", "cd /c/Temp/land/tree/src && ls"],
		["a quoted native path", 'cd "C:\\Users\\me\\.omp\\wt\\run" && ls', 'cd "C:\\Temp\\land\\tree" && ls'],
		["escaped backslashes", "cd C:\\\\Users\\\\me\\\\.omp\\\\wt\\\\run && ls", "cd C:\\\\Temp\\\\land\\\\tree && ls"],
		["a lower-case drive", "cd c:/Users/me/.omp/wt/run && ls", "cd c:/Temp/land/tree && ls"],
	])("points %s on Windows at the temporary checkout, spelled the same way", (_, command, expected) => {
		expect(pointCommandAt(command, root, tree, "win32")).toBe(expected);
	});

	it("finds a forward-slash root in a command that names it natively", () => {
		expect(pointCommandAt('cd "C:\\Users\\me\\.omp\\wt\\run"', "C:/Users/me/.omp/wt/run", tree, "win32")).toBe(
			`cd "${tree}"`,
		);
	});

	it("replaces the path as written elsewhere", () => {
		expect(pointCommandAt("cd /home/me/run && make", "/home/me/run", "/tmp/tree", "linux")).toBe(
			"cd /tmp/tree && make",
		);
	});
});
