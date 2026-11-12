import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { DAY_MS, diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";

// Split from disk-care.test.ts so the build-output rules run beside the rest (each case runs real git dozens of times).
const w = diskCareWorld();

/** A linked worktree made by hand (a plain `git worktree add`) outside the worktree root, with the busy worktree's files. */
async function handMade(name: string): Promise<string> {
	const target = path.join(w.root, "elsewhere", name);
	gitSync(w.repo, "worktree", "add", "-q", "-b", `hand/${name}`, target, "main");
	const dir = await fs.realpath(target);
	await write(dir, "feature.ts", "export const done = 1;\n");
	gitSync(dir, "add", "feature.ts");
	gitSync(dir, "commit", "-q", "-m", "feature");
	await write(dir, "README.md", "hello, edited\n");
	await write(dir, ".env", "API_KEY=edited-in-worktree\n");
	await write(dir, "node_modules/left-pad/index.js", "module.exports = 1;\n");
	await write(dir, "out/main/index.js", "built\n");
	await write(dir, "dist/handmade.html", "<p>my page</p>\n");
	return dir;
}

describe("disk care: build output", () => {
	it(
		"drops a lockfile-backed node_modules and the build tool's out/, keeps a hand-made dist/ and the .env",
		async () => {
			const dir = await w.busyWorktree("artifacts");
			await w.care(Date.now() + 5 * DAY_MS).run("user");
			expect(await exists(path.join(dir, "node_modules"))).toBe(false);
			expect(await exists(path.join(dir, "out"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "dist/handmade.html"), "utf8")).toBe("<p>my page</p>\n");
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(w.listed()).toContain(dir);
			const line = w.logs.find(([message]) => message === "artifacts");
			expect(String(line?.[1].entries)).toMatch(/node_modules\/ \(lockfile-dependencies\)/);
		},
		SLOW,
	);

	it(
		"drops what the .gitignore files under a build-output comment and keeps what it files under any other",
		async () => {
			const dir = await w.worktree("sections");
			await fs.appendFile(path.join(dir, ".gitignore"), "\n# Build output\ngen/\n\n# My scratch notes\nscratch/\n");
			gitSync(dir, "commit", "-q", "-am", "ignore sections");
			await write(dir, "gen/bundle.js", "built\n");
			await write(dir, "scratch/ideas.md", "keep me\n");
			await w.care(Date.now() + 5 * DAY_MS).run("user");
			expect(await exists(path.join(dir, "gen"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "scratch/ideas.md"), "utf8")).toBe("keep me\n");
			const line = w.logs.find(([message]) => message === "artifacts");
			expect(String(line?.[1].entries)).toContain("gen/ (gitignore-build-section)");
		},
		SLOW,
	);

	it(
		"never takes a hand-made folder for a dev server's, Next's dev or a computed output folder",
		async () => {
			const dir = await w.worktree("tools");
			const pkg = (scripts: Record<string, string>, deps: Record<string, string>) =>
				JSON.stringify({ scripts, devDependencies: deps });
			await write(dir, "devonly/package.json", pkg({ dev: "vite" }, { vite: "5" }));
			await write(dir, "nextdev/package.json", pkg({ dev: "next dev", build: "next build" }, { next: "15" }));
			await write(dir, "computed/package.json", pkg({ build: "vite build" }, { vite: "5" }));
			await write(
				dir,
				"computed/vite.config.ts",
				'export default { build: { outDir: resolve(__dirname, "build") } };\n',
			);
			await fs.appendFile(path.join(dir, ".gitignore"), "\nout/\n.next/\n");
			gitSync(dir, "add", ".");
			gitSync(dir, "commit", "-q", "-m", "three packages");
			await write(dir, "devonly/dist/handmade.html", "mine\n");
			await write(dir, "nextdev/out/notes.md", "mine\n");
			await write(dir, "nextdev/.next/cache.bin", "built\n");
			await write(dir, "computed/dist/handmade.html", "mine\n");
			await w.care(Date.now() + 5 * DAY_MS).run("user");
			expect(await fs.readFile(path.join(dir, "devonly/dist/handmade.html"), "utf8")).toBe("mine\n");
			expect(await fs.readFile(path.join(dir, "nextdev/out/notes.md"), "utf8")).toBe("mine\n");
			expect(await fs.readFile(path.join(dir, "computed/dist/handmade.html"), "utf8")).toBe("mine\n");
			// `next build` does write `.next/`.
			expect(await exists(path.join(dir, "nextdev/.next"))).toBe(false);
		},
		SLOW,
	);

	it(
		"drops only the build output of an idle worktree made by hand outside the worktree root, and never removes it",
		async () => {
			const dir = await handMade("feature");
			// The main checkout holds the same output: it is never touched.
			await write(w.repo, "node_modules/left-pad/index.js", "module.exports = 1;\n");
			// A month idle, past the removal days too: only OMPdesk's own worktrees are ever saved and removed.
			const state = await w.care(undefined, { projects: () => [w.repo] }).run("user");
			expect(await exists(path.join(dir, "node_modules"))).toBe(false);
			expect(await exists(path.join(dir, "out"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "dist/handmade.html"), "utf8")).toBe("<p>my page</p>\n");
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("hello, edited\n");
			expect(gitSync(dir, "log", "-1", "--format=%s")).toBe("feature");
			expect(w.listed()).toContain(dir);
			expect(w.savedRefs()).toEqual([]);
			expect(await exists(path.join(w.repo, "node_modules/left-pad/index.js"))).toBe(true);
			expect(state.lastRun?.actions.map(action => action.kind)).toEqual(["artifacts"]);
			expect(w.logs.find(([message]) => message === "artifacts")?.[1].path).toBe(dir);
		},
		SLOW,
	);

	it(
		"finds a hand-made worktree through the repository of one of OMPdesk's own, with no project listed",
		async () => {
			const own = await w.busyWorktree("own");
			w.open = [own];
			const dir = await handMade("sibling");
			await w.care(Date.now() + 5 * DAY_MS).run("user");
			expect(await exists(path.join(dir, "node_modules"))).toBe(false);
			expect(await exists(path.join(own, "node_modules"))).toBe(true);
		},
		SLOW,
	);

	it(
		"keeps a hand-made worktree whole while a tab, a process or a lock holds it, or it changed within the idle days",
		async () => {
			const tab = await handMade("tab");
			const proc = await handMade("proc");
			const locked = await handMade("locked");
			gitSync(w.repo, "worktree", "lock", locked);
			w.open = [path.join(tab, "dist")];
			w.processes = [path.join(proc, "node_modules")];
			const projects = () => [w.repo];
			await w.care(undefined, { projects }).run("user");
			for (const dir of [tab, proc, locked])
				expect(await exists(path.join(dir, "node_modules/left-pad/index.js")), dir).toBe(true);
			const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => details);
			expect(kept).toEqual([{ path: proc, reason: "a process works in it" }]);

			const fresh = await handMade("fresh");
			await w.care(Date.now() + DAY_MS, { projects }).run("user");
			expect(await exists(path.join(fresh, "out/main/index.js"))).toBe(true);
		},
		SLOW,
	);
});
