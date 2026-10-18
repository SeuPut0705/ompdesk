/**
 * `postinstall` and the worktree setup hook: make `node_modules/electron` hold its binary.
 *
 * Why: bun runs electron's own `install.js` with the `node` on PATH. On Node 26 `extract-zip@2` never settles
 * while unpacking, so `node install.js` exits 0 after writing only `dist/LICENSES.chromium.html`: no
 * `path.txt`, no binary, no error ("Electron failed to install correctly"). The same script under bun's runtime
 * extracts fine from the same `~/Library/Caches/electron` zip, so this re-runs it with `process.execPath` (bun)
 * whenever the binary is missing, then checks `require("electron")` resolves to a real file.
 * Run by hand: `bun scripts/ensure-electron.ts`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

function binaryPath(): string | null {
	try {
		const dir = path.dirname(require.resolve("electron/package.json"));
		const rel = fs.readFileSync(path.join(dir, "path.txt"), "utf8");
		const file = path.join(dir, "dist", rel);
		return fs.existsSync(file) ? file : null;
	} catch {
		return null;
	}
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || process.env.ELECTRON_OVERRIDE_DIST_PATH) process.exit(0);

if (!binaryPath()) {
	let installer: string;
	try {
		installer = path.join(path.dirname(require.resolve("electron/package.json")), "install.js");
	} catch {
		console.error("ensure-electron: the electron package is not installed; run `bun install` first");
		process.exit(1);
	}
	console.log("ensure-electron: electron has no binary; running its installer under bun");
	const run = spawnSync(process.execPath, [installer], { stdio: "inherit" });
	if (run.status !== 0 || !binaryPath()) {
		console.error("ensure-electron: electron's install.js did not produce a binary");
		process.exit(1);
	}
}
console.log(`ensure-electron: ${binaryPath()}`);
