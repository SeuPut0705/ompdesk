/**
 * The Windows release job (`win`) runs `bun run test:platform`, the whole
 * suite minus `src/renderer/**`. Renderer code runs in Chromium and never sees
 * the host OS: navigator.platform is pinned by vitest.setup.ts and Windows
 * behaviour is tested by passing the platform explicitly (keymap "windows",
 * node:path's `win32`). Everything that touches the OS — paths, PATH lookup,
 * shells and `.cmd` shims, spawn, sockets and named pipes, file modes — lives
 * outside the renderer, so a new test of it runs on Windows by default. A
 * renderer test that reads the host platform would silently skip Windows, so
 * it fails here instead: move it (and the code it tests) out of the renderer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.join(__dirname, "..", "..");
const HOST_PLATFORM = /\bprocess\.platform\b|\bos\.(platform|type)\(\)|\bplatform\(\)/;

interface Workflow {
	jobs: Record<string, { steps: { run?: string }[] }>;
}

describe("Windows test scope", () => {
	it("runs every test outside the renderer on the Windows release job", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts["test:platform"]).toBe('vitest run --exclude "src/renderer/**"');
		const release = parse(
			fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
		) as Workflow;
		expect(release.jobs.win?.steps.some(step => step.run?.includes("bun run test:platform"))).toBe(true);
	});

	it("keeps host-platform checks out of renderer tests", () => {
		const renderer = path.join(ROOT, "src", "renderer");
		const offenders = fs
			.readdirSync(renderer, { recursive: true, encoding: "utf8" })
			.filter(file => /\.test\.tsx?$/.test(file))
			.filter(file => HOST_PLATFORM.test(fs.readFileSync(path.join(renderer, file), "utf8")));
		expect(offenders).toEqual([]);
	});
});
