/**
 * The agent-desktop the app ships (the default computer-use engine, src/main/agent-desktop.ts):
 *
 *   bun run build:agent-desktop [-- --all]
 *
 * downloads the release archive `scripts/agent-desktop-pin.json` names for this machine (`--all`: every pinned
 * target), refuses it unless its SHA-256 is the pinned one and it holds exactly the pinned files, all regular files,
 * and unpacks it into the gitignored `resources/agent-desktop-bin/<platform>-<arch>/` with upstream's license
 * (`LICENSES/agent-desktop-LICENSE`) and `agent-desktop.build.json` (version, archive and its SHA-256, each binary's
 * SHA-256). `scripts/after-pack.cjs` holds the packaged folder to that record and the pin; the app reads the bundled
 * version from it. On the target's own platform the unpacked CLI must print `agent-desktop <version>`. A folder that
 * already matches the pin is kept without a download.
 *
 *   bun run build:agent-desktop -- --pin-latest
 *
 * moves the pin to upstream's newest release, with the SHA-256 its checksums.txt lists for every pinned target (the
 * lookup machine setup's update uses, src/main/setup/archives.ts). Newer releases reach users through the CLI updater
 * either way; the pin is what a first launch, an offline machine and a failed update run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { stopCore } from "../src/main/core/process";
import { resolveAgentDesktopRelease } from "../src/main/setup/archives";
import { downloadVerified } from "../src/main/setup/download";
import { ensureNative } from "./build-native";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const PIN_FILE = path.join(REPO_ROOT, "scripts", "agent-desktop-pin.json");
export const BIN_ROOT = path.join(REPO_ROOT, "resources", "agent-desktop-bin");
export const LICENSE_FILE = path.join(REPO_ROOT, "LICENSES", "agent-desktop-LICENSE");
/** Read by the app (src/main/agent-desktop.ts `AGENT_DESKTOP_BUILD_RECORD`) and scripts/after-pack.cjs. */
export const BUILD_RECORD = "agent-desktop.build.json";

export interface PinTarget {
	file: string;
	sha256: string;
	binaries: string[];
}
export interface Pin {
	repo: string;
	version: string;
	targets: Record<string, PinTarget>;
}
export interface BuildRecord {
	version: string;
	target: string;
	archive: string;
	archiveSha256: string;
	binaries: Record<string, string>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fail(message: string): never {
	console.error(`build:agent-desktop: ${message}`);
	process.exit(1);
}

/**
 * The regular files of a gzipped tar archive by name. POSIX and GNU headers, pax and GNU long-name records are read;
 * any other entry (a folder, a link, a device) throws, so nothing but plain files can come out of an archive.
 */
export function untar(gz: Uint8Array): Map<string, Uint8Array> {
	const tar = gunzipSync(gz);
	const files = new Map<string, Uint8Array>();
	const text = (bytes: Uint8Array) => {
		const end = bytes.indexOf(0);
		return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
	};
	let offset = 0;
	let longName: string | null = null;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
		if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar header at byte ${offset}`);
		const type = text(header.subarray(156, 157)) || "0";
		// POSIX ustar keeps a name prefix at 345; GNU's "ustar  " header has other fields there.
		const posix = text(header.subarray(257, 263)) === "ustar" && text(header.subarray(263, 265)) === "00";
		const prefix = posix ? text(header.subarray(345, 500)) : "";
		const name = longName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
		longName = null;
		const body = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x" || type === "g") continue;
		if (type === "L") {
			longName = text(body);
			continue;
		}
		if (type !== "0") throw new Error(`${name} is not a regular file (tar type ${type})`);
		files.set(name.replace(/^\.\//, ""), body);
	}
	return files;
}

/** The record of a folder that already holds `target` of `pin` byte for byte, or null. */
function current(dir: string, key: string, pin: Pin, target: PinTarget): BuildRecord | null {
	try {
		const record = JSON.parse(fs.readFileSync(path.join(dir, BUILD_RECORD), "utf8")) as BuildRecord;
		if (record.version !== pin.version || record.target !== key || record.archiveSha256 !== target.sha256)
			return null;
		for (const name of target.binaries) {
			if (sha256(fs.readFileSync(path.join(dir, name))) !== record.binaries[name]) return null;
		}
		if (!fs.existsSync(path.join(dir, "LICENSE"))) return null;
		return record;
	} catch {
		return null;
	}
}

/**
 * The release's API URL for `file`, which serves the asset's bytes with `Accept: application/octet-stream`. On
 * 9 Nov 2026 github.com's `releases/download` path answered 504 for the Windows x64 archive alone (release run
 * 42570112727 failed twice) while this route served the same bytes.
 */
async function apiAssetUrl(pin: Pin, file: string): Promise<string | null> {
	const token = process.env.GITHUB_TOKEN;
	const response = await fetch(`https://api.github.com/repos/${pin.repo}/releases/tags/v${pin.version}`, {
		headers: { "user-agent": "ompdesk-build", ...(token ? { authorization: `Bearer ${token}` } : {}) },
	}).catch(() => null);
	if (!response?.ok) return null;
	const release = (await response.json()) as { assets?: Array<{ name: string; url: string }> };
	return release.assets?.find(asset => asset.name === file)?.url ?? null;
}

/** The first of `urls` whose bytes match `expected`, each tried 3 times; the API asset URL takes octet-stream. */
async function download(urls: () => AsyncGenerator<string>, expected: string): Promise<Uint8Array> {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-agent-desktop-"));
	const file = path.join(temp, "archive.tar.gz");
	const errors: string[] = [];
	try {
		for await (const url of urls()) {
			const api = url.startsWith("https://api.github.com/");
			let error = "";
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					await downloadVerified({
						url,
						sha256: expected,
						file,
						signal: AbortSignal.timeout(300_000),
						onProgress: () => {},
						...(api ? { accept: "application/octet-stream" } : {}),
					});
					return fs.readFileSync(file);
				} catch (caught) {
					error = caught instanceof Error ? caught.message : String(caught);
					if (/^SHA-256 mismatch/.test(error)) break;
					if (attempt < 3) await Bun.sleep(attempt * 2000);
				}
			}
			errors.push(`${url}: ${error}`);
		}
		fail(errors.join("; ") || "no download URL");
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

async function unpack(key: string, pin: Pin): Promise<void> {
	const target = pin.targets[key];
	if (!target) fail(`no pinned agent-desktop for ${key}; the app ships ${Object.keys(pin.targets).join(" and ")}`);
	const dir = path.join(BIN_ROOT, key);
	if (current(dir, key, pin, target)) {
		console.log(`build:agent-desktop: ${key} already holds agent-desktop ${pin.version}`);
		return;
	}
	const url = `https://github.com/${pin.repo}/releases/download/v${pin.version}/${target.file}`;
	const files = untar(
		await download(async function* () {
			yield url;
			const api = await apiAssetUrl(pin, target.file);
			if (api) yield api;
		}, target.sha256),
	);
	const names = [...files.keys()].sort();
	if (names.join(" ") !== [...target.binaries].sort().join(" ")) {
		fail(`${target.file} holds ${names.join(", ") || "nothing"}, not ${target.binaries.join(", ")}`);
	}
	const staging = `${dir}.staging-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	const binaries: Record<string, string> = {};
	for (const name of target.binaries) {
		const bytes = files.get(name) ?? new Uint8Array();
		fs.writeFileSync(path.join(staging, name), bytes, { mode: 0o755 });
		binaries[name] = sha256(bytes);
	}
	fs.copyFileSync(LICENSE_FILE, path.join(staging, "LICENSE"));
	const record: BuildRecord = {
		version: pin.version,
		target: key,
		archive: target.file,
		archiveSha256: target.sha256,
		binaries,
	};
	fs.writeFileSync(path.join(staging, BUILD_RECORD), `${JSON.stringify(record, null, "\t")}\n`);
	if (key === `${process.platform}-${process.arch}`) {
		const cli = path.join(staging, target.binaries[0] ?? "");
		const run = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 30_000 });
		const printed = (run.stdout ?? "").trim();
		if (printed !== `agent-desktop ${pin.version}`) {
			fs.rmSync(staging, { recursive: true, force: true });
			fail(
				`${cli} --version printed "${printed}" ${run.error ?? run.stderr ?? ""}, not agent-desktop ${pin.version}`,
			);
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.renameSync(staging, dir);
	console.log(
		`build:agent-desktop: agent-desktop ${pin.version} (${target.file}, SHA-256 ${target.sha256}) is in ${dir}`,
	);
}

/** Every pinned target moved to upstream's newest release, with the hashes its checksums.txt lists. */
async function pinLatest(pin: Pin): Promise<Pin> {
	const targets: Record<string, PinTarget> = {};
	let version = "";
	for (const [key, target] of Object.entries(pin.targets)) {
		const [platform, arch] = key.split("-");
		if (platform !== "darwin" && platform !== "win32") fail(`unknown pinned platform ${key}`);
		const release = await resolveAgentDesktopRelease(platform, arch ?? "");
		if (version && release.version !== version) fail(`targets resolved to ${version} and ${release.version}`);
		version = release.version;
		targets[key] = { ...target, file: release.file, sha256: release.sha256 };
	}
	return { ...pin, version, targets };
}

async function main(): Promise<void> {
	// The downloads and the release lookup run in the core.
	ensureNative();
	const args = process.argv.slice(2);
	let pin = JSON.parse(fs.readFileSync(PIN_FILE, "utf8")) as Pin;
	if (args.includes("--pin-latest")) {
		pin = await pinLatest(pin);
		fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);
		console.log(`build:agent-desktop: pinned agent-desktop ${pin.version}`);
		return;
	}
	const keys = args.includes("--all") ? Object.keys(pin.targets) : [`${process.platform}-${process.arch}`];
	for (const key of keys) await unpack(key, pin);
}

if (import.meta.main) {
	// The core is a child with an open stdin pipe: the script ends only once it is stopped.
	try {
		await main();
	} finally {
		await stopCore();
	}
}
