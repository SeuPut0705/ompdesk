/**
 * The Changes panel's checks share one watch per checkout (git-fingerprints.ts): asked again with nothing moved, no
 * git runs; any event under the worktree or its git directories makes the next ask read git; concurrent asks share
 * one read; where nothing is watched (outside a repository, a broken watch, a platform without trusted watches) every
 * ask reads git as before.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FINGERPRINT_MAX_AGE_MS, type GitFingerprintDeps, GitFingerprints } from "./git-fingerprints";
import { getGitFingerprint } from "./local/git/changes";
import { gitSync, initRepo } from "./local/git/test-repos";

function fake(overrides: Partial<GitFingerprintDeps> = {}) {
	let n = 0;
	const events: Array<() => void> = [];
	const failures: Array<() => void> = [];
	const watched: string[] = [];
	const read = vi.fn(async () => ({ fingerprint: `fp-${++n}` }));
	let clock = 0;
	const fingerprints = new GitFingerprints({
		read,
		locate: async cwd => [cwd, path.join(cwd, ".git"), path.join(cwd, ".git")],
		watch: (dir, changed, failed) => {
			watched.push(dir);
			events.push(changed);
			failures.push(failed);
			return { close: vi.fn() };
		},
		now: () => clock,
		watches: true,
		...overrides,
	});
	return {
		fingerprints,
		read,
		watched,
		event: () => {
			for (const changed of events) changed();
		},
		fail: () => failures[0]?.(),
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("GitFingerprints", () => {
	it("answers from memory while nothing moved, and reads git again after any event", async () => {
		const f = fake();
		expect(await f.fingerprints.read("/repo")).toEqual({ fingerprint: "fp-1" });
		expect(await f.fingerprints.read("/repo", "/repo")).toEqual({ fingerprint: "fp-1" });
		expect(f.read).toHaveBeenCalledOnce();
		// The worktree holds .git: one watch covers both.
		expect(f.watched).toEqual([path.resolve("/repo")]);
		f.event();
		expect(await f.fingerprints.read("/repo")).toEqual({ fingerprint: "fp-2" });
		expect(f.read).toHaveBeenCalledTimes(2);
		f.fingerprints.dispose();
	});

	it("passes the root it found, so the read skips asking git for it", async () => {
		const f = fake();
		await f.fingerprints.read("/repo/sub");
		expect(f.read).toHaveBeenCalledWith("/repo/sub", path.resolve("/repo/sub"));
		f.fingerprints.dispose();
	});

	it("shares one read among concurrent asks, and keeps no answer read across an event", async () => {
		const f = fake();
		const gate = Promise.withResolvers<void>();
		let n = 0;
		f.read.mockImplementation(async () => {
			n += 1;
			if (n === 1) await gate.promise;
			return { fingerprint: `fp-${n}` };
		});
		const first = f.fingerprints.read("/repo");
		const second = f.fingerprints.read("/repo");
		await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
		// The file changed while git was reading: this read may have missed it.
		f.event();
		gate.resolve();
		expect(await first).toEqual({ fingerprint: "fp-1" });
		expect(await second).toEqual({ fingerprint: "fp-1" });
		expect(await f.fingerprints.read("/repo")).toEqual({ fingerprint: "fp-2" });
		f.fingerprints.dispose();
	});

	it("reads again once an answer is older than the safety bound, event or not", async () => {
		const f = fake();
		await f.fingerprints.read("/repo");
		f.advance(FINGERPRINT_MAX_AGE_MS);
		await f.fingerprints.read("/repo");
		expect(f.read).toHaveBeenCalledTimes(2);
		f.fingerprints.dispose();
	});

	it("reads git every time outside a repository, after a watch broke, or where watches are not trusted", async () => {
		const outside = fake({ locate: async () => null });
		await outside.fingerprints.read("/plain");
		await outside.fingerprints.read("/plain");
		expect(outside.read).toHaveBeenCalledTimes(2);

		const broken = fake();
		await broken.fingerprints.read("/repo");
		broken.fail();
		await broken.fingerprints.read("/repo");
		await broken.fingerprints.read("/repo");
		expect(broken.read).toHaveBeenCalledTimes(3);
		broken.fingerprints.dispose();

		const linux = fake({ watches: false });
		await linux.fingerprints.read("/repo");
		await linux.fingerprints.read("/repo");
		expect(linux.read).toHaveBeenCalledTimes(2);
		expect(linux.watched).toEqual([]);
	});
});

describe.runIf(process.platform === "darwin" || process.platform === "win32")(
	"GitFingerprints on a real checkout",
	() => {
		const dirs: string[] = [];
		afterEach(async () => {
			await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
		});

		it("runs no git while the checkout is untouched, and sees an edit, a staged file and a stash at the next ask", async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-fp-")));
			dirs.push(root);
			await initRepo(root);
			const read = vi.fn(getGitFingerprint);
			const fingerprints = new GitFingerprints({
				read,
				locate: async cwd => {
					const out = gitSync(
						cwd,
						"rev-parse",
						"--path-format=absolute",
						"--show-toplevel",
						"--absolute-git-dir",
						"--git-common-dir",
					);
					return out.split("\n").map(line => path.resolve(line.trim()));
				},
				watch: (dir, changed, failed) => {
					const { watch } = process.getBuiltinModule("node:fs");
					const watcher = watch(dir, { recursive: true, persistent: false }, changed);
					watcher.on("error", failed);
					return watcher;
				},
			});
			try {
				const clean = (await fingerprints.read(root)).fingerprint;
				// The repository's own setup may still report (a commit's background `git maintenance`): wait until a
				// read runs no git, then nothing more may.
				await expect
					.poll(
						async () => {
							const calls = read.mock.calls.length;
							await fingerprints.read(root);
							return read.mock.calls.length === calls;
						},
						{ timeout: 5_000 },
					)
					.toBe(true);
				const settled = read.mock.calls.length;
				for (let i = 0; i < 5; i++) expect((await fingerprints.read(root)).fingerprint).toBe(clean);
				expect(read).toHaveBeenCalledTimes(settled);
				// FSEvents and ReadDirectoryChangesW report within tens of milliseconds; the panel's next check is 3 s on.
				const moves = async (change: () => Promise<void> | void) => {
					const before = (await fingerprints.read(root)).fingerprint;
					await change();
					await expect
						.poll(async () => (await fingerprints.read(root)).fingerprint, { timeout: 5_000 })
						.not.toBe(before);
				};
				await moves(() => fs.writeFile(path.join(root, "README.md"), "edited\n"));
				await moves(() => fs.writeFile(path.join(root, "README.md"), "edited again, same status letters\n"));
				await moves(() => {
					gitSync(root, "add", "README.md");
				});
				await moves(() => {
					gitSync(root, "stash", "push", "-q");
				});
				// What the cache answers is what git answers.
				expect((await fingerprints.read(root)).fingerprint).toBe((await getGitFingerprint(root)).fingerprint);
			} finally {
				fingerprints.dispose();
			}
		});
	},
);
