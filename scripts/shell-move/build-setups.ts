/**
 * The two setups of the dry run (scripts/shell-move/run-move.ts), both real electron-builder NSIS builds under a test
 * identity (`nsis.guid`, `nsis.shortcutName`: constants.ts), so neither can touch the person's install, uninstall
 * entry or shortcuts:
 *
 *   old   the RELEASED v0.127.0 app files (the setup that release published, its app payload unpacked, SHA-256 checked
 *         against GitHub's digest) wrapped in a setup of the same one-click shape: the install the updater under test
 *         runs in, with an uninstaller of its own. Built `--prepackaged`, from the released release's installer.nsh.
 *   new   the shell build of this checkout (electron-builder.win.yml: the same package a release makes) offered as
 *         0.200.0, with scripts/shell-move/move-test.nsh included (its seams: the setup's environment is logged, an
 *         unpack can be made incomplete on purpose, and the app is started through a launcher that carries the test
 *         profile, because the setup starts it through Explorer, which has none of the setup's environment).
 *
 *   bun scripts/shell-move/build-setups.ts --work <dir> [--only old|new] [--stand-in <project>]
 *
 * Electron-builder runs through `bun run locked` (it is a heavy build). Writes `<work>/old/dist/*.exe`,
 * `<work>/new/dist/*.exe` and `<work>/released/app/` (the unpacked release, which the profile seed also uses).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import {
	assertTestIdentity,
	OFFERED_VERSION,
	RELEASED_TAG,
	RELEASED_VERSION,
	REPO,
	REPO_ROOT,
	TEST_GUID,
	TEST_SHORTCUT,
} from "./constants";
import { run } from "./guard";

/** Byte offset and length of the 7z archive an NSIS setup embeds stored (electron-builder's `app-64.7z`). */
export function findEmbedded7z(bytes: Uint8Array): { offset: number; length: number } {
	const signature = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let best: { offset: number; length: number } | null = null;
	for (
		let at = bytes.indexOf(signature[0] ?? 0);
		at >= 0 && at < bytes.length - 32;
		at = bytes.indexOf(signature[0] ?? 0, at + 1)
	) {
		if (!signature.every((byte, index) => bytes[at + index] === byte)) continue;
		const length = 32 + Number(view.getBigUint64(at + 12, true)) + Number(view.getBigUint64(at + 20, true));
		if (at + length <= bytes.length && (!best || length > best.length)) best = { offset: at, length };
	}
	if (!best) throw new Error("no 7z archive is embedded in the setup");
	return best;
}

async function releasedSetup(work: string): Promise<string> {
	const dir = join(work, "released");
	const file = join(dir, "ompdesk-windows-setup.exe");
	mkdirSync(dir, { recursive: true });
	const api = (await (
		await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASED_TAG}`, {
			headers: { "user-agent": "ompdesk-shell-move" },
		})
	).json()) as {
		assets?: Array<{ name: string; digest?: string; browser_download_url: string }>;
	};
	const asset = api.assets?.find(entry => entry.name === "ompdesk-windows-setup.exe");
	if (!asset?.digest?.startsWith("sha256:"))
		throw new Error(`release ${RELEASED_TAG} lists no Windows setup with a SHA-256 digest`);
	const expected = asset.digest.slice("sha256:".length);
	const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	if (existsSync(file) && sha(readFileSync(file)) === expected) return file;
	console.log(`shell-move: downloading ${RELEASED_TAG}'s setup`);
	const bytes = new Uint8Array(await (await fetch(asset.browser_download_url)).arrayBuffer());
	if (sha(bytes) !== expected) throw new Error(`the downloaded setup does not hash to GitHub's digest ${expected}`);
	await Bun.write(file, bytes);
	return file;
}

async function unpackReleased(work: string): Promise<string> {
	const app = join(work, "released", "app");
	if (existsSync(join(app, "OMPdesk.exe"))) return app;
	const setup = await releasedSetup(work);
	const bytes = new Uint8Array(await Bun.file(setup).arrayBuffer());
	const { offset, length } = findEmbedded7z(bytes);
	const archive = join(work, "released", "app-64.7z");
	await Bun.write(archive, bytes.subarray(offset, offset + length));
	rmSync(app, { recursive: true, force: true });
	mkdirSync(app, { recursive: true });
	// Windows' own bsdtar reads 7z.
	const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	const unpacked = await run([tar, "-xf", archive, "-C", app]);
	if (unpacked.code !== 0 || !existsSync(join(app, "OMPdesk.exe")))
		throw new Error(`tar could not unpack ${archive}: ${unpacked.out}`);
	return app;
}

type Config = Record<string, unknown> & {
	nsis?: Record<string, unknown>;
	win?: Record<string, unknown>;
	directories?: Record<string, unknown>;
	extraResources?: Array<{ from: string; to: string }>;
};

/**
 * electron-builder.win.yml as the move's config: test identity, absolute paths (the file lives outside the repository).
 * `root` is the project the new setup packs: this checkout, or a `--stand-in` project of the same shape with fewer
 * files for a dry test of the harness itself (its package check is left out and its missing resources are skipped).
 */
function moveConfig(kind: "old" | "new", work: string, include: string, root: string): string {
	const config = parse(readFileSync(join(REPO_ROOT, "electron-builder.win.yml"), "utf8")) as Config;
	const abs = (path: unknown) => (typeof path === "string" ? resolve(root, path) : path);
	const standIn = root !== REPO_ROOT;
	config.nsis = {
		...config.nsis,
		guid: TEST_GUID,
		shortcutName: TEST_SHORTCUT,
		include,
		installerIcon: abs(config.nsis?.installerIcon),
		uninstallerIcon: abs(config.nsis?.uninstallerIcon),
	};
	config.win = { ...config.win, icon: abs(config.win?.icon) };
	config.directories = { buildResources: join(REPO_ROOT, "resources"), output: join(work, kind, "dist") };
	if (kind === "new") {
		config.electronDist = abs(config.electronDist);
		config.afterExtract = resolve(REPO_ROOT, config.afterExtract as string);
		if (standIn) delete config.afterPack;
		else config.afterPack = resolve(REPO_ROOT, config.afterPack as string);
		config.extraResources = config.extraResources
			?.map(entry => ({ ...entry, from: abs(entry.from) as string }))
			.filter(entry => !standIn || existsSync(entry.from));
	} else {
		// `--prepackaged`: electron-builder neither unpacks an engine nor copies files nor runs the hooks.
		for (const key of ["electronDist", "afterPack", "afterExtract", "extraResources", "files"]) delete config[key];
	}
	const file = join(work, kind, "electron-builder.yml");
	mkdirSync(join(work, kind), { recursive: true });
	writeFileSync(file, stringify(config));
	return file;
}

function git(args: string[]): string {
	const shown = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT });
	if (shown.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${shown.stderr.toString()}`);
	return shown.stdout.toString();
}

async function builder(
	kind: "old" | "new",
	work: string,
	config: string,
	version: string,
	extra: string[],
	root: string,
): Promise<string> {
	const out = join(work, kind, "dist");
	rmSync(out, { recursive: true, force: true });
	const build = Bun.spawn(
		[
			"bun",
			"run",
			"locked",
			"--",
			"bunx",
			"electron-builder",
			"--projectDir",
			root,
			"--config",
			config,
			"--win",
			"--x64",
			"--publish",
			"never",
			`-c.extraMetadata.version=${version}`,
			...extra,
		],
		{
			cwd: REPO_ROOT,
			stdout: "inherit",
			stderr: "inherit",
			env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: "4" },
		},
	);
	if ((await build.exited) !== 0) throw new Error(`electron-builder (${kind}) failed`);
	const setup = readdirSync(out).find(name => name.endsWith("-setup.exe"));
	if (!setup) throw new Error(`electron-builder (${kind}) left no setup in ${out}`);
	return join(out, setup);
}

/** `new`'s include: move-test.nsh with the path of the release's own installer.nsh in place. */
function testInclude(work: string): string {
	const file = join(work, "new", "move-test.nsh");
	mkdirSync(join(work, "new"), { recursive: true });
	const real = join(REPO_ROOT, "resources", "installer.nsh");
	writeFileSync(
		file,
		readFileSync(join(import.meta.dir, "move-test.nsh"), "utf8").replace("installer-under-test.nsh", real),
	);
	return file;
}

export async function buildSetups(
	work: string,
	options: { only?: "old" | "new"; standIn?: string } = {},
): Promise<{ old: string; new: string }> {
	assertTestIdentity();
	const { only, standIn } = options;
	const root = standIn ? resolve(standIn) : REPO_ROOT;
	let old = "";
	let current = "";
	// The old setup depends on nothing of this checkout (the release's files, its installer.nsh): kept between runs.
	const keptOld = existsSync(join(work, "old", "dist"))
		? readdirSync(join(work, "old", "dist")).find(name => name.endsWith("-setup.exe"))
		: undefined;
	if (keptOld) old = join(work, "old", "dist", keptOld);
	if (only !== "new" && !keptOld) {
		const app = await unpackReleased(work);
		// The old setup is the old release's: its installer.nsh (git's copy at the tag), no seams.
		const include = join(work, "old", "installer.nsh");
		mkdirSync(join(work, "old"), { recursive: true });
		writeFileSync(include, git(["show", `${RELEASED_TAG}:resources/installer.nsh`]));
		old = await builder(
			"old",
			work,
			moveConfig("old", work, include, REPO_ROOT),
			RELEASED_VERSION,
			["--prepackaged", app],
			REPO_ROOT,
		);
	}
	if (only !== "old")
		current = await builder("new", work, moveConfig("new", work, testInclude(work), root), OFFERED_VERSION, [], root);
	return { old, new: current };
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: { work: { type: "string" }, only: { type: "string" }, "stand-in": { type: "string" } },
	});
	if (!values.work)
		throw new Error(
			"usage: bun scripts/shell-move/build-setups.ts --work <dir> [--only old|new] [--stand-in <project>]",
		);
	const built = await buildSetups(resolve(values.work), {
		...(values.only === "old" || values.only === "new" ? { only: values.only } : {}),
		...(values["stand-in"] ? { standIn: values["stand-in"] } : {}),
	});
	console.log(JSON.stringify(built));
}
