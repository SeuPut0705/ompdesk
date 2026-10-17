/**
 * Regenerate the README media: record every scene on the built app and the fake omp (`out/`, so run
 * `bun run build` first when the UI changed), then encode `docs/media/`.
 *
 *   bun run readme:media                    all scenes
 *   bun run readme:media -- hero autopilot  only these scenes (a scene is its file name before `.scene.ts`;
 *                                           `hero` is both the light and the dark clip)
 *
 * Playwright runs inside the machine-wide build lock, like every other Playwright run on this Mac.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeAll } from "./encode";
import { RAW_DIR } from "./lib";

const HERE = import.meta.dir;
const ROOT = path.resolve(HERE, "../..");
const scenes = process.argv.slice(2);
const files = scenes.length > 0 ? scenes.map(name => path.join("scripts/readme-media/scenes", `${name}.scene.ts`)) : [];

for (const file of files) if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`no such scene: ${file}`);

fs.rmSync(RAW_DIR, { recursive: true, force: true });
const playwright = path.join(ROOT, "node_modules/.bin/playwright");
const args = ["test", "-c", "scripts/readme-media/playwright.config.ts", ...files];
// The lock is held already when this runs under `bun run locked` (the env var tells build-lock.ts so).
const held = process.env.OMPDESK_BUILD_LOCK_HELD === "1";
const result = held
	? spawnSync(playwright, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, OMP_GUI_HEADLESS: "1" } })
	: spawnSync("bun", ["scripts/build-lock.ts", playwright, ...args], {
			cwd: ROOT,
			stdio: "inherit",
			env: { ...process.env, OMP_GUI_HEADLESS: "1" },
		});
if (result.status !== 0) process.exit(result.status ?? 1);
encodeAll();
