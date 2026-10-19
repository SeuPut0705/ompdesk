const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const plist = require("plist");

/**
 * Electron locale files `electronLanguages` keeps (both builder configs): en-US,
 * Chromium's hard fallback (without `en-US.pak` the renderer aborts at startup,
 * issue #12), and ko, the UI's other language. electron-builder keeps a file
 * whose name equals a listed language or prefixes it, so macOS keeps `en.lproj`.
 */
const KEPT_LOCALES = { darwin: ["en.lproj", "ko.lproj"], win32: ["en-US.pak", "ko.pak"] };

/** Fail the package unless exactly the kept locales survived, in every directory that holds them. */
async function checkLocales(context) {
	const platform = context.electronPlatformName;
	const kept = KEPT_LOCALES[platform];
	if (!kept) return;
	const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents");
	const dirs =
		platform === "darwin"
			? [
					path.join(contents, "Resources"),
					path.join(contents, "Frameworks", "Electron Framework.framework", "Resources"),
				]
			: [path.join(context.appOutDir, "locales")];
	const ext = path.extname(kept[0]);
	for (const dir of dirs) {
		const found = (await fs.readdir(dir)).filter(name => path.extname(name) === ext).sort();
		if (found.join(",") !== kept.join(",")) {
			throw new Error(`${dir} holds locales ${found.join(", ") || "none"}; expected exactly ${kept.join(", ")}`);
		}
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

/**
 * electron-builder enables arbitrary ATS loads after applying mac.extendInfo so
 * its localhost updater exception works. Restore the app's explicit policy
 * after that mutation and before the bundle is signed.
 */
async function afterPack(context) {
	await checkLocales(context);
	await checkAiMemory(context);
	if (context.electronPlatformName !== "darwin") return;

	const bundle = `${context.packager.appInfo.productFilename}.app`;
	const infoPath = path.join(context.appOutDir, bundle, "Contents", "Info.plist");
	const info = plist.parse(await fs.readFile(infoPath, "utf8"));
	const transport = info.NSAppTransportSecurity;
	info.NSAppTransportSecurity = {
		...(transport && typeof transport === "object" ? transport : {}),
		NSAllowsArbitraryLoads: false,
		NSAllowsLocalNetworking: true,
	};
	await fs.writeFile(infoPath, plist.build(info));
}

module.exports = { afterPack, KEPT_LOCALES };
