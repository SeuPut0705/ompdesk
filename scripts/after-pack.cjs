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

/**
 * electron-builder enables arbitrary ATS loads after applying mac.extendInfo so
 * its localhost updater exception works. Restore the app's explicit policy
 * after that mutation and before the bundle is signed.
 */
async function afterPack(context) {
	await checkLocales(context);
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
