/**
 * The Node runtime the shell build starts `out/main/index.js` with (`<resources>/node/node[.exe]`, see
 * native-rust › S and `crates/shell`):
 *
 *   bun run build:node [-- --all]
 *
 * downloads the nodejs.org archive `scripts/node-runtime-pin.json` names for this machine (`--all`: every pinned
 * target), refuses it unless its SHA-256 is the pinned one, takes `node`/`node.exe` and Node's `LICENSE` out of it and
 * stages them in the gitignored `resources/node/<platform>-<arch>/` with `node.build.json` (version, archive and its
 * SHA-256, the binary's SHA-256). `scripts/after-pack.cjs` holds the packaged folder to that record and the pin; on the
 * target's own platform the staged binary must print `v<version>`. A folder that already matches the pin is kept
 * without a download.
 *
 *   bun run build:node -- --check     the staged folder against the pin and its record, nothing downloaded
 *   bun run build:node -- --pin-latest   moves the pin to nodejs.org's newest 24.x LTS with its SHASUMS256.txt hashes
 *
 * Node 24 is the LTS line main was written and tested on (the repo's `.node-version`-less CI runs 24); a new 24.x patch
 * release is a pin bump, a new major is a decision.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_FILE = path.join(REPO_ROOT, "scripts", "node-runtime-pin.json");
export const NODE_ROOT = path.join(REPO_ROOT, "resources", "node");
/** Read by scripts/after-pack.cjs. */
export const BUILD_RECORD = "node.build.json";
const MAJOR = "24";

export interface NodePinTarget {
	file: string;
	sha256: string;
	/** The staged file name. */
	binary: string;
	/** Its path inside the archive, and the archive's LICENSE. */
	inArchive: string;
	license: string;
}
export interface NodePin {
	version: string;
	targets: Record<string, NodePinTarget>;
}
export interface NodeBuildRecord {
	version: string;
	target: string;
	archive: string;
	archiveSha256: string;
	binary: string;
	binarySha256: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fail(message: string): never {
	console.error(`build:node: ${message}`);
	process.exit(1);
}

export const readPin = (): NodePin => JSON.parse(fs.readFileSync(PIN_FILE, "utf8")) as NodePin;

/** The regular files of a gzipped tar archive named in `wanted`; folders, links and every other entry are skipped. */
export function untarFiles(gz: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array> {
	const tar = gunzipSync(gz);
	const files = new Map<string, Uint8Array>();
	const text = (bytes: Uint8Array) => {
		const end = bytes.indexOf(0);
		return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
	};
	let offset = 0;
	let longName: string | null = null;
	let paxPath: string | null = null;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
		if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar header at byte ${offset}`);
		const type = text(header.subarray(156, 157)) || "0";
		const posix = text(header.subarray(257, 263)) === "ustar" && text(header.subarray(263, 265)) === "00";
		const prefix = posix ? text(header.subarray(345, 500)) : "";
		const name =
			paxPath ?? longName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
		const body = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			paxPath = /\d+ path=([^\n]*)\n/.exec(text(body))?.[1] ?? null;
			continue;
		}
		if (type === "g") continue;
		if (type === "L") {
			longName = text(body);
			continue;
		}
		longName = null;
		paxPath = null;
		if (type !== "0") continue;
		const clean = name.replace(/^\.\//, "");
		if (wanted.has(clean)) files.set(clean, body);
	}
	return files;
}

/** The two files of an archive, as bytes. */
async function extract(
	archive: Uint8Array,
	target: NodePinTarget,
): Promise<{ binary: Uint8Array; license: Uint8Array }> {
	const wanted = new Set([target.inArchive, target.license]);
	let found: Map<string, Uint8Array>;
	if (target.file.endsWith(".zip")) {
		const zip = await JSZip.loadAsync(archive);
		found = new Map();
		for (const name of wanted) {
			const entry = zip.file(name);
			if (entry) found.set(name, await entry.async("uint8array"));
		}
	} else {
		found = untarFiles(archive, wanted);
	}
	const binary = found.get(target.inArchive);
	const license = found.get(target.license);
	if (!binary || !license) fail(`${target.file} lacks ${[...wanted].filter(name => !found.has(name)).join(", ")}`);
	return { binary, license };
}

/** The record of a folder that already holds `target` of `pin` byte for byte, or null. */
export function current(dir: string, key: string, pin: NodePin, target: NodePinTarget): NodeBuildRecord | null {
	try {
		const record = JSON.parse(fs.readFileSync(path.join(dir, BUILD_RECORD), "utf8")) as NodeBuildRecord;
		if (record.version !== pin.version || record.target !== key || record.archiveSha256 !== target.sha256)
			return null;
		if (record.binary !== target.binary) return null;
		if (sha256(fs.readFileSync(path.join(dir, target.binary))) !== record.binarySha256) return null;
		if (!fs.existsSync(path.join(dir, "LICENSE"))) return null;
		return record;
	} catch {
		return null;
	}
}

async function download(pin: NodePin, target: NodePinTarget): Promise<Uint8Array> {
	const url = `https://nodejs.org/dist/v${pin.version}/${target.file}`;
	const errors: string[] = [];
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const actual = sha256(bytes);
			if (actual !== target.sha256) fail(`${url} hashes to ${actual}, the pin says ${target.sha256}`);
			return bytes;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			if (attempt < 3) await Bun.sleep(attempt * 2000);
		}
	}
	fail(`${url}: ${errors.join("; ")}`);
}

export async function stageNode(key: string, pin: NodePin): Promise<void> {
	const target = pin.targets[key];
	if (!target) fail(`no pinned Node for ${key}; the app ships ${Object.keys(pin.targets).join(" and ")}`);
	const dir = path.join(NODE_ROOT, key);
	if (current(dir, key, pin, target)) {
		console.log(`build:node: ${key} already holds Node ${pin.version}`);
		return;
	}
	const { binary, license } = await extract(await download(pin, target), target);
	const staging = `${dir}.staging-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	fs.writeFileSync(path.join(staging, target.binary), binary, { mode: 0o755 });
	fs.writeFileSync(path.join(staging, "LICENSE"), license);
	const record: NodeBuildRecord = {
		version: pin.version,
		target: key,
		archive: target.file,
		archiveSha256: target.sha256,
		binary: target.binary,
		binarySha256: sha256(binary),
	};
	fs.writeFileSync(path.join(staging, BUILD_RECORD), `${JSON.stringify(record, null, "\t")}\n`);
	if (key === `${process.platform}-${process.arch}`) {
		const run = spawnSync(path.join(staging, target.binary), ["--version"], { encoding: "utf8", timeout: 30_000 });
		const printed = (run.stdout ?? "").trim();
		if (printed !== `v${pin.version}`) {
			fs.rmSync(staging, { recursive: true, force: true });
			fail(`${target.binary} --version printed "${printed}" ${run.error ?? run.stderr ?? ""}, not v${pin.version}`);
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.renameSync(staging, dir);
	console.log(`build:node: Node ${pin.version} (${target.file}, SHA-256 ${target.sha256}) is in ${dir}`);
}

/** `--check`: the staged folder of this machine against the pin; throws on a difference. */
export function checkNode(key = `${process.platform}-${process.arch}`): NodeBuildRecord {
	const pin = readPin();
	const target = pin.targets[key];
	if (!target) fail(`no pinned Node for ${key}`);
	const record = current(path.join(NODE_ROOT, key), key, pin, target);
	if (!record) fail(`resources/node/${key} is missing or is not Node ${pin.version}; run \`bun run build:node\``);
	return record;
}

/** Every pinned target moved to nodejs.org's newest 24.x LTS, with the hashes its SHASUMS256.txt lists. */
async function pinLatest(pin: NodePin): Promise<NodePin> {
	const index = (await (await fetch("https://nodejs.org/dist/index.json")).json()) as Array<{
		version: string;
		lts: string | false;
	}>;
	const latest = index.find(entry => entry.lts && entry.version.startsWith(`v${MAJOR}.`));
	if (!latest) fail(`nodejs.org lists no ${MAJOR}.x LTS`);
	const version = latest.version.slice(1);
	const sums = await (await fetch(`https://nodejs.org/dist/v${latest.version.slice(1)}/SHASUMS256.txt`)).text();
	const targets: Record<string, NodePinTarget> = {};
	for (const [key, target] of Object.entries(pin.targets)) {
		const file = target.file.replace(/node-v[\d.]+-/, `node-v${version}-`);
		const hash = new RegExp(`^([0-9a-f]{64})  ${file.replace(/\./g, "\\.")}$`, "m").exec(sums)?.[1];
		if (!hash) fail(`SHASUMS256.txt of v${version} lists no ${file}`);
		const folder = file.replace(/\.(zip|tar\.gz)$/, "");
		targets[key] = {
			...target,
			file,
			sha256: hash,
			inArchive: target.inArchive.replace(/^[^/]+/, folder),
			license: target.license.replace(/^[^/]+/, folder),
		};
	}
	return { version, targets };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--check")) {
		const record = checkNode();
		console.log(`build:node: Node ${record.version} is staged (${record.binarySha256})`);
		return;
	}
	let pin = readPin();
	if (args.includes("--pin-latest")) {
		pin = await pinLatest(pin);
		fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);
		console.log(`build:node: pinned Node ${pin.version}`);
		return;
	}
	const keys = args.includes("--all") ? Object.keys(pin.targets) : [`${process.platform}-${process.arch}`];
	for (const key of keys) await stageNode(key, pin);
}

if (import.meta.main) await main();
