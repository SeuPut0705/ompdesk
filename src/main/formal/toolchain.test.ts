/**
 * The pinned toolchain: the pin file parses and pins every platform, a download is checked against its SHA-256,
 * refused downloads end in UNAVAILABLE (exit 3, "not checked"), and setup is lazy and idempotent. No test here
 * touches the network or the real home: the cache is a temp folder and the sources are file:// URLs.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cacheRoot,
	platformKey,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/cache";
import { Unavailable } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/proc";
import {
	parseJavaMajor,
	prepareTla,
	tlaStatus,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tla-env";
import {
	DEFAULT_TOOLCHAIN_FILE,
	download,
	loadToolchain,
	parseToolchain,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-toolchain-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

const sha = (data: string): string => createHash("sha256").update(data).digest("hex");
const fileUrl = (file: string): string => `file://${file.startsWith("/") ? "" : "/"}${file.replaceAll("\\", "/")}`;

describe("assets/toolchain.json", () => {
	const pins = loadToolchain({ OMPDESK_FORMAL_TOOLCHAIN: DEFAULT_TOOLCHAIN_FILE });

	it("pins TLC, the community modules, a JRE, elan and Lean by SHA-256 over https", () => {
		expect(pins.tla.tla2tools.version).toMatch(/^1\.8\./);
		expect(pins.tla.tla2tools.url).toMatch(
			/^https:\/\/github\.com\/tlaplus\/tlaplus\/releases\/download\/v1\.8\.0\//,
		);
		expect(pins.lean.toolchain).toBe(`leanprover/lean4:v${pins.lean.version}`);
		for (const url of [pins.tla.tla2tools.url, pins.tla.communityModules.url]) expect(url).toMatch(/^https:\/\//);
	});

	it("covers macOS arm64 and x64 and Windows x64 for the Java runtime, elan and Lean", () => {
		for (const table of [pins.tla.jre.platforms, pins.lean.elan.platforms, pins.lean.archive.platforms]) {
			expect(Object.keys(table).sort()).toEqual(["darwin-arm64", "darwin-x64", "win32-x64"]);
			for (const entry of Object.values(table)) {
				expect(entry.url).toMatch(/^https:\/\//);
				expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
			}
		}
		expect(pins.tla.jre.platforms["win32-x64"]?.format).toBe("zip");
		expect(pins.tla.jre.platforms["darwin-arm64"]?.format).toBe("tar.gz");
		// macOS bsdtar cannot read .tar.zst without a zstd program: the Lean archives are zip everywhere.
		for (const entry of Object.values(pins.lean.archive.platforms)) expect(entry.format).toBe("zip");
	});

	it("rejects a malformed pin file with the field named", () => {
		const raw = JSON.parse(fs.readFileSync(DEFAULT_TOOLCHAIN_FILE, "utf8"));
		expect(() => parseToolchain({ ...raw, version: 2 })).toThrow(/version/);
		const badHash = structuredClone(raw);
		badHash.tla.tla2tools.sha256 = "abc";
		expect(() => parseToolchain(badHash)).toThrow(/tla2tools\.sha256/);
		const http = structuredClone(raw);
		http.tla.communityModules.url = "http://example.com/x.jar";
		expect(() => parseToolchain(http)).toThrow(/communityModules\.url/);
		const odd = structuredClone(raw);
		odd.lean.toolchain = "leanprover/lean4:v9.9.9";
		expect(() => parseToolchain(odd)).toThrow(/lean\.toolchain/);
		const platform = structuredClone(raw);
		platform.tla.jre.platforms.plan9 = platform.tla.jre.platforms["darwin-arm64"];
		expect(() => parseToolchain(platform)).toThrow(/platform keys/);
	});
});

describe("cache and Java probing", () => {
	it("puts the cache under ~/.cache/ompdesk/formal on macOS and %LOCALAPPDATA% on Windows, and honours the override", () => {
		expect(cacheRoot({}, "darwin", "/Users/u")).toBe("/Users/u/.cache/ompdesk/formal");
		expect(cacheRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
			"C:\\Users\\u\\AppData\\Local\\ompdesk\\formal",
		);
		expect(cacheRoot({ OMPDESK_FORMAL_CACHE: temp }, "darwin", "/Users/u")).toBe(temp);
		expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
	});

	it("reads the major version of every banner java prints, and nothing from the macOS stub", () => {
		expect(parseJavaMajor('openjdk version "17.0.19" 2026-04-21')).toBe(17);
		expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8);
		expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
		expect(parseJavaMajor("The operation couldn't be completed. Unable to locate a Java Runtime.")).toBeUndefined();
	});
});

describe("download", () => {
	it("keeps a file whose SHA-256 matches, and leaves nothing behind when it does not", async () => {
		const source = path.join(temp, "payload.bin");
		fs.writeFileSync(source, "payload");
		const log = (): void => {};
		const good = path.join(temp, "dl", "good.bin");
		await download(fileUrl(source), good, sha("payload"), { label: "payload", log });
		expect(fs.readFileSync(good, "utf8")).toBe("payload");
		const bad = path.join(temp, "dl", "bad.bin");
		await expect(download(fileUrl(source), bad, sha("something else"), { label: "payload", log })).rejects.toThrow(
			/SHA-256 mismatch/,
		);
		expect(fs.readdirSync(path.join(temp, "dl"))).toEqual(["good.bin"]);
		await expect(
			download(fileUrl(path.join(temp, "missing.bin")), bad, sha("x"), { label: "missing", log }),
		).rejects.toBeInstanceOf(Unavailable);
	});

	it("refuses every download under OMPDESK_FORMAL_OFFLINE=1", async () => {
		const source = path.join(temp, "payload.bin");
		await expect(
			download(fileUrl(source), path.join(temp, "dl", "offline.bin"), sha("payload"), {
				label: "payload",
				env: { OMPDESK_FORMAL_OFFLINE: "1" },
				log: () => {},
			}),
		).rejects.toThrow(/refused/);
		expect(fs.existsSync(path.join(temp, "dl", "offline.bin"))).toBe(false);
	});
});

describe("setup when nothing can be downloaded", () => {
	const env = (cache: string): NodeJS.ProcessEnv => ({
		...process.env,
		OMPDESK_FORMAL_CACHE: cache,
		OMPDESK_FORMAL_OFFLINE: "1",
		OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1",
	});

	it("is UNAVAILABLE, never a pass: prepareTla throws, status lists what is missing", async () => {
		const cache = fs.mkdtempSync(path.join(temp, "offline-"));
		await expect(prepareTla({ env: env(cache) })).rejects.toBeInstanceOf(Unavailable);
		const status = await tlaStatus(env(cache));
		expect(status.ready).toBe(false);
		expect(status.missing.join(" ")).toContain("tla2tools");
		expect(fs.readdirSync(cache).filter(name => !name.startsWith("."))).toEqual([]);
	});

	it("makes setup.ts and tlc.ts exit 3 with UNAVAILABLE, and setup.ts exit 2 without a target", () => {
		const cache = fs.mkdtempSync(path.join(temp, "offline-"));
		const setup = spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "tla"], {
			encoding: "utf8",
			env: env(cache),
		});
		expect(setup.status).toBe(3);
		expect(setup.stdout).toContain("UNAVAILABLE tla");
		const check = spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "lean", "--check"], {
			encoding: "utf8",
			env: env(cache),
		});
		expect(check.status).toBe(3);
		expect(check.stdout).toContain("UNAVAILABLE lean");
		const spec = path.join(SKILL, "examples/job-lease/formal/job-lease/tla/JobLease.tla");
		const tlc = spawnSync(
			"bun",
			[path.join(SKILL, "scripts/tlc.ts"), spec, "--config", path.join(path.dirname(spec), "MC.cfg")],
			{
				encoding: "utf8",
				env: env(cache),
			},
		);
		expect(tlc.status).toBe(3);
		expect(tlc.stdout).toContain("UNAVAILABLE");
		expect(
			spawnSync("bun", [path.join(SKILL, "scripts/setup.ts")], { encoding: "utf8", env: env(cache) }).status,
		).toBe(2);
		expect(
			spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "rust"], { encoding: "utf8", env: env(cache) }).status,
		).toBe(2);
	}, 30_000);
});

describe.skipIf(process.platform === "win32")("prepareTla from local pins", () => {
	it("fetches each jar once, checks its hash, and reuses it without a network", async () => {
		const cache = fs.mkdtempSync(path.join(temp, "pins-"));
		const sources = path.join(cache, "src");
		fs.mkdirSync(sources);
		fs.writeFileSync(path.join(sources, "tla2tools.jar"), "tla jar");
		fs.writeFileSync(path.join(sources, "community.jar"), "community jar");
		const pins = JSON.parse(fs.readFileSync(DEFAULT_TOOLCHAIN_FILE, "utf8"));
		pins.tla.tla2tools.url = fileUrl(path.join(sources, "tla2tools.jar"));
		pins.tla.tla2tools.sha256 = sha("tla jar");
		pins.tla.communityModules.url = fileUrl(path.join(sources, "community.jar"));
		pins.tla.communityModules.sha256 = sha("community jar");
		const pinFile = path.join(cache, "toolchain.json");
		fs.writeFileSync(pinFile, JSON.stringify(pins));
		const java = path.join(cache, "fake-java");
		fs.writeFileSync(java, "#!/bin/sh\necho 'openjdk version \"17.0.1\"' >&2\n", { mode: 0o755 });
		const env = {
			...process.env,
			OMPDESK_FORMAL_CACHE: cache,
			OMPDESK_FORMAL_TOOLCHAIN: pinFile,
			OMPDESK_FORMAL_JAVA: java,
		};
		const quiet = (): void => {};
		const first = await prepareTla({ env, log: quiet });
		expect(first.java).toBe(java);
		expect(first.javaMajor).toBe(17);
		expect(fs.readFileSync(first.tla2tools, "utf8")).toBe("tla jar");
		expect(first.classpath).toBe([first.tla2tools, first.community].join(path.delimiter));
		// Idempotent: with the sources gone and downloads refused, the verified files are used as they are.
		fs.rmSync(sources, { recursive: true });
		const second = await prepareTla({ env: { ...env, OMPDESK_FORMAL_OFFLINE: "1" }, log: quiet });
		expect(second.tla2tools).toBe(first.tla2tools);
		// A file that no longer matches its pin is not trusted: it is fetched again, and offline that is UNAVAILABLE.
		fs.writeFileSync(first.tla2tools, "tampered");
		await expect(prepareTla({ env: { ...env, OMPDESK_FORMAL_OFFLINE: "1" }, log: quiet })).rejects.toBeInstanceOf(
			Unavailable,
		);
	}, 30_000);
});
