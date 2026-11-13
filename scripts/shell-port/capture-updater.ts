/**
 * Records input → output tables of the updater's pure TypeScript, so the Rust port (`shell_core::updater_core`)
 * can be replayed against them. Run: `bun scripts/shell-port/capture-updater.ts`.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitHubRelease, UpdatePlatform } from "../../src/main/update-release";
import {
	parseUpdateMetadata,
	pickRelease,
	resolvePlatformRelease,
	stripUpdateMetadata,
} from "../../src/main/update-release";
import {
	classifyRepoAccess,
	githubApiHeaders,
	installerPartialPath,
	isSwappableBundleLocation,
	macBundlePath,
	macDownloadName,
	planInstallerTransfer,
	SWAP_SCRIPT,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	sweepInstallerPartials,
} from "../../src/main/updater-state";
import type { UpdateAccess, UpdateStatus } from "../../src/shared/ipc-types";

interface SemverLib {
	parse(version: string): unknown;
	gt(latest: string, current: string): boolean;
}
const semver = createRequire(import.meta.url)("semver") as SemverLib;

const root = join(import.meta.dir, "../..");
const outPath = join(root, "native/ompdesk/crates/shell/src/updater_core/captured.json");

type Case = { in: Record<string, unknown> } & ({ out: unknown } | { error: { code?: string; message: string } });

/** `undefined` inputs are dropped by JSON, so a missing key means undefined. */
function run(input: Record<string, unknown>, fn: () => unknown): Case {
	try {
		return { in: input, out: fn() ?? null };
	} catch (error) {
		const e = error as { code?: string; message?: string };
		return {
			in: input,
			error: e.code ? { code: e.code, message: String(e.message) } : { message: String(e.message) },
		};
	}
}
const table = <T>(inputs: T[], input: (t: T) => Record<string, unknown>, fn: (t: T) => unknown): Case[] =>
	inputs.map(t => run(input(t), () => fn(t)));

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

// 1
const repoAccess: [number, boolean][] = [
	...[200, 201, 204, 299, 300, 301, 304, 400, 401].map((s): [number, boolean] => [s, false]),
	[403, true],
	[403, false],
	[404, true],
	[404, false],
	...[408, 422, 429, 500, 502, 503, 0].map((s): [number, boolean] => [s, false]),
];
const classify = table(
	repoAccess,
	([status, rateLimited]) => ({ status, rateLimited }),
	([status, rateLimited]) => classifyRepoAccess(status, rateLimited),
);

// 2
const accesses: UpdateAccess[] = ["ok", "missing", "invalid", "denied", "network"];
const settleFailed: Case[] = [];
for (const access of accesses)
	for (const errorCode of [undefined, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "ERR_OMPDESK_UPDATE_METADATA", "X"])
		for (const manual of [true, false])
			for (const detail of [undefined, "MSG", "DETAIL"])
				settleFailed.push(
					run({ access, errorCode, message: "MSG", currentVersion: "1.2.3", manual, detail }, () =>
						settleFailedUpdateCheck(access, errorCode, "MSG", "1.2.3", manual, detail),
					),
				);

// 3
const statuses: UpdateStatus[] = [
	{ state: "idle" },
	{ state: "checking" },
	{ state: "available", version: "1.2.4" } as UpdateStatus,
	{ state: "downloaded", version: "1.2.4" } as UpdateStatus,
	{ state: "error", message: "boom" },
];
const settleIncomplete: Case[] = [];
for (const status of statuses)
	for (const manual of [true, false])
		settleIncomplete.push(
			run({ status, manual, noResultMessage: "NR" }, () => settleIncompleteUpdateCheck(status, manual, "NR")),
		);

// 4
const transfer: Case[] = [];
for (const existingBytes of [0, 100, 5])
	for (const status of [200, 206, 416])
		for (const contentRange of [
			undefined,
			"bytes 100-199/200",
			"bytes 99-199/200",
			"BYTES 100-",
			"bytes 100-*",
			"garbage",
			"bytes  100-1/2",
		])
			transfer.push(
				run({ existingBytes, status, contentRange }, () =>
					planInstallerTransfer(existingBytes, { status, contentRange }),
				),
			);

// 5: the real sweep over a temp folder
const debrisNames = [
	"ompdesk-0.1.2.dmg.partial",
	"ompdesk-0.1.2-arm64.dmg.partial",
	"ompdesk-0.1.2-arm64 (2).dmg.partial",
	"ompdesk-0.1.2 (3).dmg.partial",
	"ompdesk-0.1.2.dmg.download-123",
	"ompdesk-0.1.2-arm64.dmg.download-9",
	"ompdesk-0.1.2.dmg.download-",
	"ompdesk-0.1.2.dmg.download-x",
	"ompdesk-0.1.2.dmg",
	"ompdesk-0.1.2-arm64.dmg",
	"holiday.dmg.partial",
	"ompdesk-1.dmg.partial",
	"ompdesk-a.b.dmg.partial",
	"ompdesk-0.1.2-x64.dmg.partial",
	"OMPDESK-0.1.2.dmg.partial",
	"ompdesk-0.1.2 (x).dmg.partial",
	"ompdesk-0.1.2(2).dmg.partial",
	"ompdesk-.dmg.partial",
	"ompdesk-0.1.2-arm64-arm64.dmg.partial",
	"ompdesk-0.1.2.dmg.partial.bak",
	"ompdesk-0.1.2.DMG.partial",
	"ompdesk-10.20.30-arm64.dmg.download-77",
	"ompdesk-0.1.2-beta.dmg.partial",
	"xompdesk-0.1.2.dmg.partial",
	"notes.txt",
];
const sweepDir = mkdtempSync(join(tmpdir(), "capture-updater-"));
const debris: Case[] = [];
for (const name of debrisNames)
	for (const activePartial of [undefined, name, "ompdesk-0.1.2.dmg.partial"]) {
		const dir = mkdtempSync(join(sweepDir, "d-"));
		writeFileSync(join(dir, name), "x");
		const removed = await sweepInstallerPartials(
			dir,
			activePartial === undefined ? undefined : join(dir, activePartial),
		);
		debris.push({
			in: { name, ...(activePartial === undefined ? {} : { activePartial }) },
			out: removed.includes(name),
		});
	}
rmSync(sweepDir, { recursive: true, force: true });

// 6
const execPaths = [
	"/Applications/OMPdesk.app/Contents/MacOS/OMPdesk",
	"/Applications/ompdesk.app/Contents/MacOS/ompdesk/",
	"/Applications/OMPdesk.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
	"/Applications/OMPdesk.app/Contents/Resources/OMPdesk",
	"/usr/local/bin/ompdesk",
	"/Applications/OMPdesk/Contents/MacOS/OMPdesk",
	"OMPdesk.app/Contents/MacOS/OMPdesk",
	"Contents/MacOS/OMPdesk",
	"C:\\Program Files\\OMPdesk\\OMPdesk.exe",
	"C:\\Apps\\OMPdesk.app\\Contents\\MacOS\\OMPdesk",
	"",
	"/OMPdesk.app/Contents/MacOS/OMPdesk",
	"/Volumes/OMPdesk 1.0/OMPdesk.app/Contents/MacOS/OMPdesk",
];
const bundlePath = table(
	execPaths,
	execPath => ({ execPath }),
	execPath => macBundlePath(execPath),
);
const swappable = table(
	[
		"/Applications/OMPdesk.app",
		"/Users/a/Applications/OMPdesk.app",
		"/Volumes/OMPdesk/OMPdesk.app",
		"/Volumes",
		"/private/var/folders/xx/AppTranslocation/ABC/d/OMPdesk.app",
		"/AppTranslocation/x.app",
		"/Users/a/Volumes/OMPdesk.app",
		"",
	],
	bundle => ({ bundle }),
	bundle => isSwappableBundleLocation(bundle),
);

// 7
const downloadName = table(
	["0.1.2", "1.0.0-beta.1", "10.20.30", ""],
	version => ({ version }),
	v => macDownloadName(v),
);
const partialPath = table(
	["/Users/a/Downloads/ompdesk-0.1.2-arm64.dmg", "ompdesk.dmg", ""],
	destinationPath => ({ destinationPath }),
	p => installerPartialPath(p),
);

// 8
const headers: Case[] = [];
for (const token of [undefined, "", "t"])
	for (const accept of [undefined, "application/octet-stream"])
		headers.push(run({ token, accept }, () => githubApiHeaders(token, accept)));

// 9
const SHA_A = `${"A".repeat(86)}==`;
const SHA_B = `${"a1+/".repeat(21)}a1==`;
const file = (name: string, over: Record<string, unknown> = {}) => ({ name, size: 100, sha512: SHA_A, ...over });
const MAC = "ompdesk-mac-arm64.dmg";
const WIN = "ompdesk-windows-setup.exe";
const meta = (over: Record<string, unknown> = {}) => ({
	version: "1.2.3",
	releaseDate: "2026-01-02T03:04:05Z",
	files: { mac: file(MAC), windows: file(WIN) },
	...over,
});
const comment = (json: unknown) => `<!-- ompdesk-update ${typeof json === "string" ? json : JSON.stringify(json)} -->`;
const withFiles = (files: unknown) => comment(meta({ files }));
const bodies: (string | null | undefined)[] = [
	comment(meta()),
	withFiles({ mac: file(MAC) }),
	withFiles({ windows: file(WIN) }),
	withFiles({}),
	"Notes without a comment",
	"",
	null,
	undefined,
	`${comment(meta())}\n${comment(meta())}`,
	comment("not json {"),
	comment(meta({ version: "1.2" })),
	comment(meta({ version: "v1.2.3" })),
	comment(meta({ version: "1.2.3-beta.1" })),
	comment(meta({ version: "1.2.3+build.5" })),
	comment(meta({ version: "1.2.3-rc.1+b.2" })),
	comment(meta({ version: "01.02.03" })),
	comment(meta({ releaseDate: "yesterday" })),
	comment(meta({ releaseDate: "2026-01-02T03:04:05.123Z" })),
	comment(meta({ releaseDate: "2026-01-02T03:04:05+09:00" })),
	comment(meta({ releaseDate: "2026-01-02 03:04:05Z" })),
	comment(meta({ releaseDate: "2026-01-02" })),
	comment(meta({ releaseDate: "2026-01-02T03:04:05" })),
	comment(meta({ releaseDate: "2026-02-30T03:04:05Z" })),
	withFiles({ mac: file("other.dmg") }),
	withFiles({ mac: file(MAC, { size: 0 }) }),
	withFiles({ mac: file(MAC, { size: -5 }) }),
	withFiles({ mac: file(MAC, { size: 1.5 }) }),
	withFiles({ mac: file(MAC, { size: "100" }) }),
	withFiles({ mac: file(MAC, { sha512: "AAAA" }) }),
	withFiles({ mac: file(MAC, { sha512: "A".repeat(88) }) }),
	withFiles({ mac: file(MAC, { sha512: `${"!".repeat(86)}==` }) }),
	withFiles({ mac: file(MAC, { sha512: SHA_B }) }),
	comment({ ...meta(), extra: 1 }),
	comment({ version: "1.2.3", releaseDate: "2026-01-02T03:04:05Z" }),
	`Intro\n\n<!--   ompdesk-update\n  ${JSON.stringify(meta())}\n  -->\n\nOutro`,
	`<!--ompdesk-update ${JSON.stringify(meta())}-->`,
	`<!-- ompdesk-update-x ${JSON.stringify(meta())} -->`,
	comment("[]"),
	comment("null"),
];
const parseMetadata = table(bodies, body => ({ body }), parseUpdateMetadata);
const stripBodies: (string | null | undefined)[] = [
	null,
	"just notes",
	`Top\n${comment(meta())}\nBottom`,
	`${comment(meta())}\n${comment(meta())}`,
	`\n  \t  Notes\n\n${comment(meta())}  \n`,
	`${comment(meta())}`,
];
const strip = table(stripBodies, body => ({ body }), stripUpdateMetadata);

// 10 / 11
const ASSET_URL = (id: number) => `https://api.github.com/repos/SeuPut0705/ompdesk/releases/assets/${id}`;
const rel = (over: Record<string, unknown> = {}) => ({
	tag_name: "v1.2.3",
	name: "OMPdesk 1.2.3",
	body: comment(meta()),
	draft: false,
	prerelease: false,
	assets: [
		{ id: 123, name: MAC, size: 100, url: ASSET_URL(123) },
		{ id: 124, name: WIN, size: 100, url: ASSET_URL(124) },
	],
	...over,
});
const releasePayloads: unknown[] = [
	rel(),
	rel({ name: null, body: null }),
	rel({ name: undefined, body: undefined }),
	{ ...rel(), tag_name: undefined },
	rel({ tag_name: 5 }),
	rel({ draft: "no" }),
	rel({ prerelease: undefined }),
	rel({ assets: undefined }),
	rel({ assets: [{ id: 1, name: MAC, size: 100, url: "not a url" }] }),
	rel({ assets: [{ id: "1", name: MAC, size: 100, url: ASSET_URL(1) }] }),
	rel({ assets: [{ id: 1, name: MAC, size: "100", url: ASSET_URL(1) }] }),
	rel({ assets: [] }),
	rel({ assets: [{ id: 1, name: MAC, size: 100, url: "ftp://x.y/z" }] }),
	null,
	"x",
	[rel()],
	[],
	[rel({ draft: true })],
	[rel({ draft: true }), rel({ draft: true, prerelease: true })],
	[rel({ tag_name: "v1.2.4", draft: true }), rel({ tag_name: "v1.2.3" })],
	[rel({ tag_name: "v1.2.3" }), rel({ tag_name: "v1.2.4-beta.1", prerelease: true })],
	[rel({ tag_name: "v1.2.4-beta.2", prerelease: true }), rel({ tag_name: "v1.2.4-beta.1", prerelease: true }), rel()],
	[rel({ tag_name: "v1.2.4-beta.2", prerelease: true, draft: true }), rel({ tag_name: "v1.2.3" })],
	[rel({ tag_name: "v1.2.4" }), rel({ tag_name: "v1.2.3" })],
	[rel(), { tag_name: "bad" }],
];
const pick: Case[] = [];
for (const allowPrerelease of [false, true])
	for (const payload of releasePayloads)
		pick.push(run({ payload, allowPrerelease }, () => pickRelease(payload, allowPrerelease)));

const body = (over: Record<string, unknown> = {}) => comment(meta(over));
const asset = (name: string, size: number, id = 200) => ({ id, name, size, url: ASSET_URL(id) });
const releases: GitHubRelease[] = [
	rel(),
	rel({ tag_name: "v1.2.4" }),
	rel({ body: body({ files: { windows: file(WIN) } }) }),
	rel({ body: body({ files: { mac: file(MAC) } }) }),
	rel({ body: body({ files: {} }) }),
	rel({ assets: [asset(WIN, 100, 124)] }),
	rel({ assets: [asset(MAC, 100, 123)] }),
	rel({ assets: [asset(MAC, 99, 123), asset(WIN, 99, 124)] }),
	rel({ name: null }),
	rel({ name: "" }),
	rel({ name: undefined }),
	rel({ body: `Release notes\n\n${body()}\n\nMore` }),
	rel({ body: "no comment" }),
	rel({ body: null }),
	rel({ assets: [asset(MAC, 100, 5), asset(MAC, 100, 6), asset(WIN, 100, 7)] }),
].map(r => r as unknown as GitHubRelease);
const resolve: Case[] = [];
for (const platform of ["mac", "windows"] as UpdatePlatform[])
	for (const release of releases)
		resolve.push(run({ release, platform }, () => resolvePlatformRelease(release, platform)));

// 12
const pairs: [string, string][] = [
	["1.0.0", "1.0.0"],
	["1.0.1", "1.0.0"],
	["1.0.0", "1.0.1"],
	["2.0.0", "1.9.9"],
	["1.10.0", "1.9.0"],
	["1.0.0-alpha", "1.0.0"],
	["1.0.0", "1.0.0-alpha"],
	["1.0.0-alpha.1", "1.0.0-alpha"],
	["1.0.0-alpha", "1.0.0-alpha.1"],
	["1.0.0-beta", "1.0.0-alpha.1"],
	["1.0.0-alpha.1", "1.0.0-beta"],
	["1.0.0-beta.2", "1.0.0-beta.11"],
	["1.0.0-beta.11", "1.0.0-beta.2"],
	["1.0.0-rc.1", "1.0.0-beta"],
	["1.0.0", "1.0.0-rc.1"],
	["1.0.0-1", "1.0.0-alpha"],
	["1.0.0-alpha", "1.0.0-1"],
	["1.0.0-2", "1.0.0-10"],
	["1.0.0-10", "1.0.0-2"],
	["1.0.0-alpha.beta", "1.0.0-alpha.1"],
	["1.0.0-alpha.1", "1.0.0-alpha.beta"],
	["1.0.0-x.7.z.92", "1.0.0-x.7.z.9"],
	["1.0.0+build.1", "1.0.0"],
	["1.0.0", "1.0.0+build.1"],
	["1.0.1+a", "1.0.0+b"],
	["1.0.0-beta+exp.sha", "1.0.0-alpha"],
	["v1.0.1", "1.0.0"],
	["v1.0.0", "1.0.0"],
	["01.0.0", "1.0.0"],
	["1.00.0", "1.0.0"],
	["1.0.0-01", "1.0.0"],
	["1.0", "0.9.0"],
	["1", "0.9.0"],
	["garbage", "1.0.0"],
	["", "1.0.0"],
	[" 1.0.1 ", "1.0.0"],
	["=1.0.1", "1.0.0"],
	["1.0.0.1", "1.0.0"],
	["1.2.3-", "1.2.3"],
	["1.2.3-a..b", "1.2.3"],
	["999999999.0.0", "1.0.0"],
	["9007199254740993.0.0", "1.0.0"],
];
const semverGt = table(
	pairs,
	([latest, current]) => ({ latest, current }),
	([latest, current]) => {
		const parsed = semver.parse(latest) != null;
		return { parsed, gt: parsed ? semver.gt(latest, current) : false };
	},
);

// 14
const MAC_IV = Buffer.alloc(16, 0x20);
const macPlain = [
	"hello",
	"",
	"a".repeat(15),
	"b".repeat(16),
	"c".repeat(17),
	"비밀번호 🔑 ünï",
	"ghp_0123456789abcdefghijABCDEFGHIJ012345",
	"token with spaces\nand newline",
];
const macPasswords = [
	"pw",
	"Zm9vYmFy",
	"correct horse battery staple",
	"",
	"ß",
	"p".repeat(24),
	"k3y",
	"0123456789abcdef",
];
const safeStorageMac = macPlain.map((plaintext, i) => {
	const password = Buffer.from(macPasswords[i] ?? "pw");
	const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	const cipher = createCipheriv("aes-128-cbc", key, MAC_IV);
	const sealed = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
	return { passwordBase64: b64(password), plaintext, blobBase64: b64(Buffer.concat([Buffer.from("v10"), sealed])) };
});
const winKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const winPlain = ["hello", "", "a".repeat(16), "비밀번호 🔑", "ghp_0123456789abcdefghijABCDEFGHIJ012345", "x"];
const safeStorageWin = winPlain.map((plaintext, i) => {
	const nonce = Buffer.from(Array.from({ length: 12 }, (_, j) => (i * 17 + j * 5 + 1) & 0xff));
	const cipher = createCipheriv("aes-256-gcm", winKey, nonce);
	const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
	const blob = Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
	return { keyBase64: b64(winKey), nonceBase64: b64(nonce), plaintext, blobBase64: b64(blob) };
});

const captured = {
	capturedFrom: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
	classifyRepoAccess: classify,
	settleFailedUpdateCheck: settleFailed,
	settleIncompleteUpdateCheck: settleIncomplete,
	planInstallerTransfer: transfer,
	installerDebris: debris,
	macBundlePath: bundlePath,
	isSwappableBundleLocation: swappable,
	macDownloadName: downloadName,
	installerPartialPath: partialPath,
	githubApiHeaders: headers,
	parseUpdateMetadata: parseMetadata,
	stripUpdateMetadata: strip,
	pickRelease: pick,
	resolvePlatformRelease: resolve,
	semverGt,
	SWAP_SCRIPT,
	safeStorageMac,
	safeStorageWin,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(captured, null, 2)}\n`);
for (const [key, value] of Object.entries(captured)) console.log(key, Array.isArray(value) ? value.length : 1);
