/**
 * The licence files CEF's own archive carries, staged for packaging (the shell build's counterpart of Electron's
 * `LICENSES.chromium.html`):
 *
 *   bun run stage:cef-licenses [-- --all]
 *
 * reads the CEF archive the shell build uses (`native/ompdesk/crates/shell/cef-pin.json`, cached by
 * `bun scripts/build-shell.ts --ensure` in `native/ompdesk/crates/shell/target/cef-dl/`; downloaded there with its
 * SHA-256 checked when missing) and writes the gitignored `resources/shell-licenses/<platform>-<arch>/` with
 * `LICENSES.chromium.html` (the archive's `CREDITS.html`: Chromium's and every bundled library's notices, which
 * Chromium's licences require to travel with the binary) and `LICENSE.cef.txt` (CEF's BSD licence). Both builder
 * configs ship the folder's two files in the app's resources; `scripts/after-pack.cjs` refuses a package without them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHELL_DIR = path.join(REPO_ROOT, "native", "ompdesk", "crates", "shell");
export const LICENSES_ROOT = path.join(REPO_ROOT, "resources", "shell-licenses");
/** Packaged platform → the pin's platform key. */
export const CEF_PLATFORMS: Record<string, string> = { "win32-x64": "windows64", "darwin-arm64": "macosarm64" };

interface CefPin {
	downloadBase: string;
	platforms: Record<string, { name: string; sha256: string }>;
}

function fail(message: string): never {
	console.error(`stage:cef-licenses: ${message}`);
	process.exit(1);
}

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The cached archive of `key`, downloaded (and its SHA-256 checked) when the shell build has not fetched it yet. */
async function archive(pin: CefPin, key: string): Promise<string> {
	const entry = pin.platforms[CEF_PLATFORMS[key] ?? ""];
	if (!entry) fail(`cef-pin.json has no archive for ${key}`);
	const file = path.join(SHELL_DIR, "target", "cef-dl", entry.name);
	if (fs.existsSync(file) && sha256File(file) === entry.sha256) return file;
	console.log(`stage:cef-licenses: fetching ${entry.name}`);
	const response = await fetch(`${pin.downloadBase}${encodeURIComponent(entry.name)}`);
	if (!response.ok) fail(`${entry.name}: HTTP ${response.status}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.part`, new Uint8Array(await response.arrayBuffer()));
	if (sha256File(`${file}.part`) !== entry.sha256) {
		fs.rmSync(`${file}.part`);
		fail(`${entry.name} does not hash to the pinned ${entry.sha256}`);
	}
	fs.renameSync(`${file}.part`, file);
	return file;
}

async function stage(key: string, pin: CefPin): Promise<void> {
	const file = await archive(pin, key);
	const top = path.basename(file).replace(/\.tar\.bz2$/, "");
	const out = path.join(LICENSES_ROOT, key);
	const scratch = fs.mkdtempSync(path.join(LICENSES_ROOT, ".extract-"));
	try {
		// bsdtar reads bzip2 itself; on Windows System32's is the one that is always there.
		const tar =
			process.platform === "win32"
				? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		const run = spawnSync(tar, ["-xjf", file, "-C", scratch, `${top}/CREDITS.html`, `${top}/LICENSE.txt`], {
			encoding: "utf8",
		});
		if (run.status !== 0) fail(`tar failed on ${file}: ${run.stderr || run.error}`);
		fs.rmSync(out, { recursive: true, force: true });
		fs.mkdirSync(out, { recursive: true });
		fs.copyFileSync(path.join(scratch, top, "CREDITS.html"), path.join(out, "LICENSES.chromium.html"));
		fs.copyFileSync(path.join(scratch, top, "LICENSE.txt"), path.join(out, "LICENSE.cef.txt"));
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	console.log(`stage:cef-licenses: ${key} → ${out}`);
}

if (import.meta.main) {
	const pin = JSON.parse(fs.readFileSync(path.join(SHELL_DIR, "cef-pin.json"), "utf8")) as CefPin;
	fs.mkdirSync(LICENSES_ROOT, { recursive: true });
	const keys = process.argv.includes("--all") ? Object.keys(CEF_PLATFORMS) : [`${process.platform}-${process.arch}`];
	for (const key of keys) await stage(key, pin);
}
