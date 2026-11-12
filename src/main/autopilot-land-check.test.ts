import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLandCandidate } from "./autopilot-ship-test-rig";
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
