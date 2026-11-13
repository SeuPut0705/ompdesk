const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const plist = require("plist");
const bundle = require("./mac-bundle-info.cjs");

/**
 * The packaged app of the CEF shell (native-rust › S). electron-builder's Windows pack (`electron-builder.win.yml`,
 * a custom `electronDist`) and `scripts/package-mac.ts` (the bundle it assembles itself) both end here, before
 * signing: every check below throws and so fails the package.
 */

/** Where the files of a packed app sit: `resources` (Windows: beside the exe; macOS: inside the bundle) and the root. */
function layout(context) {
	const productFilename = context.packager.appInfo.productFilename;
	if (context.electronPlatformName === "darwin") {
		const contents = path.join(context.appOutDir, `${productFilename}.app`, "Contents");
		return {
			contents,
			resources: path.join(contents, "Resources"),
			frameworks: path.join(contents, "Frameworks"),
			executable: path.join(contents, "MacOS", productFilename),
		};
	}
	return {
		contents: context.appOutDir,
		resources: path.join(context.appOutDir, "resources"),
		frameworks: context.appOutDir,
		executable: path.join(context.appOutDir, `${productFilename}.exe`),
	};
}

/** A file's SHA-256, streamed (CEF's libcef is 200 MB and more). */
async function sha256File(file) {
	const hash = crypto.createHash("sha256");
	const handle = await fs.open(file);
	try {
		for await (const chunk of handle.createReadStream()) hash.update(chunk);
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/** The execute bit exists only on a POSIX file system; a Windows host (a test of the darwin check there) cannot express it. */
async function requireExecutable(platform, file) {
	if (platform === "darwin" && process.platform !== "win32" && ((await fs.stat(file)).mode & 0o111) === 0)
		throw new Error(`${file} is not executable`);
}

/**
 * Locale files kept (both platforms): en-US, Chromium's hard fallback (without `en-US.pak` the renderer aborts at
 * startup, issue #12), and ko, the UI's other language. CEF's macOS framework keeps them as `en.lproj` and `ko.lproj`.
 */
const KEPT_LOCALES = { darwin: ["en.lproj", "ko.lproj"], win32: ["en-US.pak", "ko.pak"] };

/** Fail the package unless exactly the kept locales survived, in every directory that holds them. */
async function checkLocales(context) {
	const platform = context.electronPlatformName;
	const kept = KEPT_LOCALES[platform];
	if (!kept) return;
	const where = layout(context);
	const dirs =
		platform === "darwin"
			? [path.join(bundle.frameworkRoot(path.join(where.frameworks, bundle.FRAMEWORK)), "Resources")]
			: [path.join(context.appOutDir, "locales")];
	const ext = path.extname(kept[0]);
	for (const dir of dirs) {
		const found = (await fs.readdir(dir)).filter(name => path.extname(name) === ext).sort();
		if (found.join(",") !== kept.join(",")) {
			throw new Error(`${dir} holds locales ${found.join(", ") || "none"}; expected exactly ${kept.join(", ")}`);
		}
	}
}

/** The shell's staged folder per packaged platform (`bun run build:shell`) and the record it leaves in it. */
const SHELL_BINARIES = { darwin: "ompdesk-shell", win32: "ompdesk-shell.exe" };
const SHELL_RECORD = "ompdesk-shell.build.json";

/**
 * Fail the package unless the shell is in the packed app exactly as `bun run build:shell` staged it: its build record
 * (`ompdesk-shell.build.json`) lists every staged file with its SHA-256 and this holds each packed file to it (this
 * runs before rcedit and signing; the executable is the record's `ompdesk-shell.exe` under the product's name; on macOS
 * the product's name is the launcher and the shell stays `ompdesk-shell` beside it), CEF with it. On macOS the helper apps
 * are copies of the shell.
 */
async function checkShell(context) {
	const platform = context.electronPlatformName;
	const binary = SHELL_BINARIES[platform];
	if (!binary) return;
	const where = layout(context);
	const recordFile = path.join(platform === "darwin" ? where.resources : where.contents, SHELL_RECORD);
	let record;
	try {
		record = JSON.parse(await fs.readFile(recordFile, "utf8"));
	} catch {
		throw new Error(`${recordFile} is missing; run \`bun run build:shell\` before packaging`);
	}
	if (record.binary !== binary || !record.files?.[binary] || record.platform !== platform) {
		throw new Error(`${recordFile} describes ${record.binary} for ${record.platform}, not ${binary} for ${platform}`);
	}
	// macOS: `Contents/MacOS/<product>` is the launcher and the shell sits beside it.
	if (platform === "darwin" && (record.launcher !== bundle.LAUNCHER || !record.files?.[bundle.LAUNCHER])) {
		throw new Error(`${recordFile} stages no ${bundle.LAUNCHER}; run \`bun run build:shell\` before packaging`);
	}
	const shellFile = platform === "darwin" ? path.join(path.dirname(where.executable), binary) : where.executable;
	if (!/^\d+\.\d+\.\d+$/.test(record.cef?.version ?? "") || !/^[0-9a-f]{64}$/.test(record.cef?.archiveSha256 ?? "")) {
		throw new Error(`${recordFile} names no CEF version and archive hash`);
	}
	for (const [name, expected] of Object.entries(record.files)) {
		const file =
			name === binary
				? shellFile
				: name === record.launcher
					? where.executable
					: path.join(platform === "darwin" ? where.frameworks : where.contents, name);
		let actual;
		try {
			actual = await sha256File(file);
		} catch {
			throw new Error(`${file} is missing; run \`bun run build:shell\` before packaging`);
		}
		if (actual !== expected) throw new Error(`${file} hashes to ${actual}; its build record expects ${expected}`);
	}
	await requireExecutable(platform, where.executable);
	if (platform !== "darwin") return;
	await requireExecutable(platform, shellFile);
	for (const helper of bundle.HELPERS) {
		const name = `${bundle.PRODUCT} Helper${helper.suffix}`;
		const file = path.join(where.frameworks, `${name}.app`, "Contents", "MacOS", name);
		let actual;
		try {
			actual = await sha256File(file);
		} catch {
			throw new Error(`${file} is missing: CEF starts its ${helper.id || "helper"} process from that name`);
		}
		if (actual !== record.files[binary]) throw new Error(`${file} is not a copy of the shell executable`);
		await requireExecutable(platform, file);
	}
}

/** The Node runtime the shell starts the main with, and the pin that decides which one. */
const NODE_PIN = path.join(__dirname, "node-runtime-pin.json");
const NODE_TARGETS = { darwin: "darwin-arm64", win32: "win32-x64" };

/**
 * Fail the package unless `<resources>/node/` holds the pinned Node (`scripts/node-runtime-pin.json`, `bun run
 * build:node`): its build record names the pinned version, target and archive hash, the binary is byte-identical to
 * the record (this runs before signing), executable on macOS, with Node's LICENSE beside it.
 */
async function checkNode(context) {
	const platform = context.electronPlatformName;
	const key = NODE_TARGETS[platform];
	if (!key) return;
	const pin = JSON.parse(await fs.readFile(NODE_PIN, "utf8"));
	const target = pin.targets[key];
	const directory = path.join(layout(context).resources, "node");
	let record;
	try {
		record = JSON.parse(await fs.readFile(path.join(directory, "node.build.json"), "utf8"));
		await fs.access(path.join(directory, "LICENSE"));
	} catch {
		throw new Error(`${directory} has no Node build record or LICENSE; run \`bun run build:node\` before packaging`);
	}
	if (record.version !== pin.version || record.target !== key || record.archiveSha256 !== target.sha256) {
		throw new Error(
			`${directory} holds Node ${record.version} (${record.target}), not the pinned ${pin.version} (${key}); run \`bun run build:node\``,
		);
	}
	const file = path.join(directory, target.binary);
	let actual;
	try {
		actual = await sha256File(file);
	} catch {
		throw new Error(`${file} is missing; run \`bun run build:node\` before packaging`);
	}
	if (record.binary !== target.binary || actual !== record.binarySha256) {
		throw new Error(`${file} hashes to ${actual}; its build record expects ${record.binarySha256}`);
	}
	await requireExecutable(platform, file);
}

/**
 * The app folder the shell runs the main from: `<resources>/app/out/main/index.js` and the preload it injects into
 * every page (`out/preload/shell.js`), the renderer it serves as `app://ompdesk/`, and the `package.json` the main
 * reads its version from. A plain folder: an `app.asar` would be an app the shell cannot start.
 */
async function checkApp(context) {
	const app = path.join(layout(context).resources, "app");
	for (const name of ["package.json", "out/main/index.js", "out/preload/shell.js", "out/renderer/index.html"]) {
		await fs.access(path.join(app, name)).catch(() => {
			throw new Error(
				`${path.join(app, name)} is missing: the shell starts the main from a plain <resources>/app folder`,
			);
		});
	}
	const asar = path.join(layout(context).resources, "app.asar");
	if (
		await fs.access(asar).then(
			() => true,
			() => false,
		)
	) {
		throw new Error(`${asar} exists; the shell's Node does not read asar archives (\`asar: false\`)`);
	}
}

/** The notices that must travel with the binary: Chromium's and CEF's (bun run stage:cef-licenses) and Node's. */
async function checkLicenses(context) {
	const resources = layout(context).resources;
	for (const name of ["LICENSES.chromium.html", "LICENSE.cef.txt", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) {
		await fs.access(path.join(resources, name)).catch(() => {
			throw new Error(
				`${path.join(resources, name)} is missing; run \`bun run stage:cef-licenses\` before packaging`,
			);
		});
	}
}

/**
 * The macOS bundle's Info.plist is written by `scripts/package-mac.ts` from `scripts/mac-bundle-info.cjs`; this holds
 * the finished file to the identity and the policy the app depends on: the bundle id the updater and the pinned
 * certificate's requirement name, the `omp://` scheme (without CFBundleURLTypes `open-url` never fires), a transport
 * policy that leaves ATS on, and a privacy prompt that names the app.
 */
async function checkInfoPlist(context) {
	if (context.electronPlatformName !== "darwin") return;
	const file = path.join(layout(context).contents, "Info.plist");
	const info = plist.parse(await fs.readFile(file, "utf8"));
	if (info.CFBundleIdentifier !== bundle.APP_ID)
		throw new Error(`${file} names bundle id ${info.CFBundleIdentifier}, not ${bundle.APP_ID}`);
	const schemes = (info.CFBundleURLTypes ?? []).flatMap(type => type.CFBundleURLSchemes ?? []);
	if (!schemes.includes("omp")) throw new Error(`${file} registers no omp:// scheme`);
	const transport = info.NSAppTransportSecurity;
	if (transport?.NSAllowsArbitraryLoads !== false || transport?.NSAllowsLocalNetworking !== true) {
		throw new Error(`${file} has no explicit transport policy that leaves ATS on and excepts loopback`);
	}
	for (const key of Object.keys(bundle.PRIVACY)) {
		if (typeof info[key] !== "string" || !/\bOMPdesk\b/.test(info[key]))
			throw new Error(`${file}: ${key} does not name OMPdesk`);
	}
}

/** The ai-memory source's version (native/memory/ompdesk.json) and the binary names `bun run build:memory` makes. */
const AI_MEMORY_SOURCE = path.join(__dirname, "..", "native", "memory", "ompdesk.json");
const AI_MEMORY_BINARIES = { darwin: "ai-memory", win32: "ai-memory.exe" };

/**
 * Fail the package unless the platform's ai-memory binary is in the packed app's Resources (`ai-memory-bin/`, from
 * `bun run build:memory`), executable on macOS (checked on a POSIX host only), and byte-identical to the SHA-256 the
 * build recorded next to it (`ai-memory.build.json`; this runs before signing), built from the current source version.
 */
async function checkAiMemory(context) {
	const platform = context.electronPlatformName;
	const binary = AI_MEMORY_BINARIES[platform];
	if (!binary) return;
	const source = JSON.parse(await fs.readFile(AI_MEMORY_SOURCE, "utf8"));
	const resources =
		platform === "darwin"
			? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
			: path.join(context.appOutDir, "resources");
	const directory = path.join(resources, "ai-memory-bin");
	const file = path.join(directory, binary);
	let bytes;
	let record;
	try {
		bytes = await fs.readFile(file);
		record = JSON.parse(await fs.readFile(path.join(directory, "ai-memory.build.json"), "utf8"));
	} catch {
		throw new Error(`${file} or its build record is missing; run \`bun run build:memory\` before packaging`);
	}
	if (record.binary !== binary)
		throw new Error(`${directory}/ai-memory.build.json describes ${record.binary}, not ${binary}`);
	if (record.version !== source.version) {
		throw new Error(
			`ai-memory was built from version ${record.version}, native/memory is ${source.version}; run \`bun run build:memory\``,
		);
	}
	// The execute bit exists only on a POSIX file system; a Windows host cannot express it (every file reads as 0o666),
	// so the mode is tested only where it means something. The recorded hash below is checked everywhere.
	if (platform === "darwin" && process.platform !== "win32" && ((await fs.stat(file)).mode & 0o111) === 0)
		throw new Error(`${file} is not executable`);
	const actual = crypto.createHash("sha256").update(bytes).digest("hex");
	if (actual !== record.binarySha256) {
		throw new Error(`${file} hashes to ${actual}; its build record expects ${record.binarySha256}`);
	}
}

/** The release the app ships (`bun run build:agent-desktop` unpacks it) and each packaged platform's pinned target. */
const AGENT_DESKTOP_PIN = path.join(__dirname, "agent-desktop-pin.json");
const AGENT_DESKTOP_TARGETS = { darwin: "darwin-arm64", win32: "win32-x64" };

/**
 * Fail the package unless the platform's agent-desktop is in the packed app's Resources (`agent-desktop-bin/`, from
 * `bun run build:agent-desktop`): its build record names the pinned version, target and archive hash, every pinned
 * binary is there byte-identical to the record (this runs before signing), executable on macOS (POSIX host only),
 * with upstream's LICENSE beside it.
 */
async function checkAgentDesktop(context) {
	const platform = context.electronPlatformName;
	const key = AGENT_DESKTOP_TARGETS[platform];
	if (!key) return;
	const pin = JSON.parse(await fs.readFile(AGENT_DESKTOP_PIN, "utf8"));
	const target = pin.targets[key];
	const resources =
		platform === "darwin"
			? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
			: path.join(context.appOutDir, "resources");
	const directory = path.join(resources, "agent-desktop-bin");
	let record;
	try {
		record = JSON.parse(await fs.readFile(path.join(directory, "agent-desktop.build.json"), "utf8"));
		await fs.access(path.join(directory, "LICENSE"));
	} catch {
		throw new Error(
			`${directory} has no agent-desktop build record or LICENSE; run \`bun run build:agent-desktop\` before packaging`,
		);
	}
	if (record.version !== pin.version || record.target !== key || record.archiveSha256 !== target.sha256) {
		throw new Error(
			`${directory} holds agent-desktop ${record.version} (${record.target}), not the pinned ${pin.version} (${key}); run \`bun run build:agent-desktop\``,
		);
	}
	for (const name of target.binaries) {
		const file = path.join(directory, name);
		const bytes = await fs.readFile(file).catch(() => {
			throw new Error(`${file} is missing; run \`bun run build:agent-desktop\` before packaging`);
		});
		if (platform === "darwin" && process.platform !== "win32" && ((await fs.stat(file)).mode & 0o111) === 0)
			throw new Error(`${file} is not executable`);
		const actual = crypto.createHash("sha256").update(bytes).digest("hex");
		if (actual !== record.binaries[name])
			throw new Error(`${file} hashes to ${actual}; its build record expects ${record.binaries[name]}`);
	}
}

/** OMPdesk's own Rust binaries (`bun run build:native`, scripts/build-native.ts `BINARIES`), by packaged platform. */
const NATIVE_BINARIES = { darwin: ["ompdesk", "ompdesk-core"], win32: ["ompdesk.exe", "ompdesk-core.exe"] };

/**
 * Fail the package unless every binary built from native/ompdesk is in the packed app's Resources (`ompdesk-bin/`),
 * executable and the bytes its build record names (`ompdesk.build.json`; this runs before signing). Whether the record
 * matches the current sources is `bun run build:native -- --check`'s to say, which the packaging jobs run first.
 */
async function checkNative(context) {
	const platform = context.electronPlatformName;
	const binaries = NATIVE_BINARIES[platform];
	if (!binaries) return;
	const resources =
		platform === "darwin"
			? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
			: path.join(context.appOutDir, "resources");
	const directory = path.join(resources, "ompdesk-bin");
	let record;
	try {
		record = JSON.parse(await fs.readFile(path.join(directory, "ompdesk.build.json"), "utf8"));
	} catch {
		throw new Error(`${directory} has no build record; run \`bun run build:native\` before packaging`);
	}
	for (const name of binaries) {
		const file = path.join(directory, name);
		let stat;
		try {
			stat = await fs.stat(file);
		} catch {
			throw new Error(`${file} is missing; run \`bun run build:native\` before packaging`);
		}
		// A Windows host (a test of the darwin check there) has no execute bit; the recorded hash is checked everywhere.
		if (platform === "darwin" && process.platform !== "win32" && (stat.mode & 0o111) === 0)
			throw new Error(`${file} is not executable`);
		const actual = crypto
			.createHash("sha256")
			.update(await fs.readFile(file))
			.digest("hex");
		if (actual !== record.binaries?.[name]) {
			throw new Error(`${file} hashes to ${actual}; its build record expects ${record.binaries?.[name]}`);
		}
	}
}

/**
 * electron-builder's `afterExtract` hook (Windows): the custom `electronDist` is unpacked as the engine's own exe name,
 * `electron.exe`, which electron-builder renames to `<productName>.exe` after the files are copied in. The shell stage
 * calls its exe `ompdesk-shell.exe`.
 */
async function afterExtract(context) {
	if (context.electronPlatformName !== "win32") return;
	await fs.rename(path.join(context.appOutDir, SHELL_BINARIES.win32), path.join(context.appOutDir, "electron.exe"));
}

/** electron-builder's `afterPack` hook (Windows) and `scripts/package-mac.ts`'s last step before signing. */
async function afterPack(context) {
	await checkLocales(context);
	await checkShell(context);
	await checkNode(context);
	await checkApp(context);
	await checkLicenses(context);
	await checkInfoPlist(context);
	await checkAiMemory(context);
	await checkAgentDesktop(context);
	await checkNative(context);
}

module.exports = { afterExtract, afterPack, KEPT_LOCALES, NATIVE_BINARIES, SHELL_BINARIES, SHELL_RECORD };
