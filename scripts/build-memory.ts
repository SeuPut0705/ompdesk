/**
 * Build OMPdesk's memory (ai-memory, vendored in `native/memory/`) for this machine and put it where packaging
 * ships it:
 *
 *   bun run build:memory
 *
 * `cargo build --locked --release -p ai-memory-cli` (the upstream's own release build: default features, the
 * workspace's thin-LTO `[profile.release]`) from `native/memory/Cargo.lock`, then
 * `resources/ai-memory-bin/<platform>-<arch>/ai-memory[.exe]` and next to it `ai-memory.build.json`, the record of
 * THIS build (binary name, SHA-256, version, upstream tag, rustc, when and how long). Both are gitignored. The
 * record is what the packaging check (`scripts/after-pack.cjs`) and the app at run time hold the shipped bytes to
 * (src/main/ai-memory/binary.ts): there is no download and no external pin.
 *
 * OMPdesk builds macOS arm64 and Windows x64, each on its own host (release.yml's `mac` and `win` jobs). Without
 * Rust (`cargo`) this prints how to get it and exits 1; the app then reports memory as not built, never crashes.
 *
 *   bun run build:memory -- --check
 *
 * builds nothing: it holds a binary and record already in `resources/ai-memory-bin/` (CI restores them from its cache
 * when their inputs did not change) to native/memory/ompdesk.json and to the current `EMBEDDED_SOURCES` (the CLI
 * embeds them with `include_str!` into the omp extension it generates, so a binary built before an edit of one is
 * stale with the same version), recomputes the binary's SHA-256 against the record and runs its `--version`; any
 * mismatch exits 1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MEMORY_DIR = path.join(REPO_ROOT, "native", "memory");
export const BIN_ROOT = path.join(REPO_ROOT, "resources", "ai-memory-bin");
export const BUILD_MANIFEST = "ai-memory.build.json";
export const BINARIES: Record<string, string> = { "darwin-arm64": "ai-memory", "win32-x64": "ai-memory.exe" };
/** OMPdesk's own files the memory CLI compiles in (install_hooks.rs `include_str!`), outside native/memory. */
export const EMBEDDED_SOURCES = ["memory-prompt.ts", "redactor.ts"].map(name =>
	path.join(REPO_ROOT, "src", "shared", name),
);

export interface BuildRecord {
	version: string;
	upstreamTag: string;
	upstreamCommit: string;
	binary: string;
	binarySha256: string;
	/** SHA-256 over `EMBEDDED_SOURCES`, in order, as the binary embedded them. */
	embeddedSha256: string;
	platform: string;
	arch: string;
	rustc: string;
	builtAt: string;
	buildSeconds: number;
}

function fail(message: string): never {
	console.error(`build:memory: ${message}`);
	process.exit(1);
}

function cargoPath(): string | null {
	const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
	const candidates = [
		...(process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, exe)),
		path.join(os.homedir(), ".cargo", "bin", exe),
	];
	return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

function check(
	key: string,
	binary: string,
	source: { version: string; upstreamCommit: string },
	embeddedSha256: string,
): void {
	const target = path.join(BIN_ROOT, key);
	const file = path.join(target, binary);
	if (!fs.existsSync(file) || !fs.existsSync(path.join(target, BUILD_MANIFEST)))
		fail(`${path.relative(REPO_ROOT, file)} or its build record is missing.`);
	const record = JSON.parse(fs.readFileSync(path.join(target, BUILD_MANIFEST), "utf8")) as BuildRecord;
	if (record.binary !== binary || record.platform !== process.platform || record.arch !== process.arch)
		fail(
			`the build record describes ${record.binary} for ${record.platform}-${record.arch}, not ${binary} for ${key}.`,
		);
	if (record.version !== source.version || record.upstreamCommit !== source.upstreamCommit)
		fail(
			`the binary was built from ${record.version} (${record.upstreamCommit}), native/memory is ${source.version} (${source.upstreamCommit}).`,
		);
	if (record.embeddedSha256 !== embeddedSha256)
		fail("the binary embeds other src/shared files than this checkout's; run `bun run build:memory`.");
	const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	if (actual !== record.binarySha256)
		fail(`${binary} hashes to ${actual}; its build record expects ${record.binarySha256}.`);
	const reported = execFileSync(file, ["--version"], { encoding: "utf8" }).trim();
	if (!reported.includes(source.version))
		fail(`the binary says "${reported}", native/memory/ompdesk.json says ${source.version}.`);
	console.log(`checked ${path.relative(REPO_ROOT, file)} (sha256 ${actual}, ${reported}, built ${record.builtAt})`);
}

if (import.meta.main) {
	const key = `${process.platform}-${process.arch}`;
	const binary = BINARIES[key];
	if (!binary) fail(`OMPdesk builds ai-memory for ${Object.keys(BINARIES).join(" and ")} only (this is ${key}).`);
	const source = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, "ompdesk.json"), "utf8")) as {
		version: string;
		upstreamTag: string;
		upstreamCommit: string;
	};
	const embedded = createHash("sha256");
	for (const file of EMBEDDED_SOURCES) embedded.update(fs.readFileSync(file));
	const embeddedSha256 = embedded.digest("hex");
	if (process.argv.includes("--check")) {
		check(key, binary, source, embeddedSha256);
		process.exit(0);
	}
	const cargo = cargoPath();
	if (!cargo) {
		fail(
			"Rust is not installed (no `cargo` on PATH). Memory needs it only when you build it yourself: install it from https://rustup.rs " +
				"(the toolchain in native/memory/rust-toolchain.toml is picked up automatically) and run `bun run build:memory` again. " +
				"Without it the app runs and reports memory as not built.",
		);
	}
	const started = Date.now();
	const run = spawnSync(cargo, ["build", "--locked", "--release", "-p", "ai-memory-cli"], {
		cwd: MEMORY_DIR,
		stdio: "inherit",
	});
	if (run.status !== 0) fail(`cargo build failed (${run.status ?? run.signal}).`);
	const buildSeconds = Math.round((Date.now() - started) / 1000);
	const built = path.join(MEMORY_DIR, "target", "release", binary);
	if (!fs.existsSync(built)) fail(`${built} was not produced.`);
	const bytes = fs.readFileSync(built);
	const target = path.join(BIN_ROOT, key);
	fs.mkdirSync(target, { recursive: true });
	const temp = path.join(target, `${binary}.tmp-${process.pid}`);
	try {
		fs.writeFileSync(temp, bytes, { mode: 0o755 });
		fs.chmodSync(temp, 0o755);
		fs.renameSync(temp, path.join(target, binary));
	} finally {
		fs.rmSync(temp, { force: true });
	}
	const reported = execFileSync(path.join(target, binary), ["--version"], { encoding: "utf8" }).trim();
	if (!reported.includes(source.version))
		fail(`the built binary says "${reported}", native/memory/ompdesk.json says ${source.version}.`);
	const record: BuildRecord = {
		version: source.version,
		upstreamTag: source.upstreamTag,
		upstreamCommit: source.upstreamCommit,
		binary,
		binarySha256: createHash("sha256").update(bytes).digest("hex"),
		embeddedSha256,
		platform: process.platform,
		arch: process.arch,
		rustc: execFileSync(
			path.join(path.dirname(cargo), process.platform === "win32" ? "rustc.exe" : "rustc"),
			["--version"],
			{ cwd: MEMORY_DIR, encoding: "utf8" },
		).trim(),
		builtAt: new Date().toISOString(),
		buildSeconds,
	};
	fs.writeFileSync(path.join(target, BUILD_MANIFEST), `${JSON.stringify(record, null, "\t")}\n`);
	console.log(
		`built ${path.relative(REPO_ROOT, path.join(target, binary))} (${bytes.length} bytes, ${buildSeconds}s, ${reported})`,
	);
}
