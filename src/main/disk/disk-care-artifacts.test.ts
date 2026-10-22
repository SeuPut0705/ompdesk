import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { DAY_MS, diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";

// Split from disk-care.test.ts so the build-output rules run beside the rest (each case runs real git dozens of times).
const w = diskCareWorld();

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
});
