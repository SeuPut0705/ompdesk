/**
 * A stand-in for OMPdesk's own bundle in the relaunch install mode (macOS): `OMP_DEV_UPDATE_BUNDLE` names the bundle
 * the update's swap replaces and `OMP_DEV_UPDATE_STAGED` a verified update already staged, so an automatic install
 * runs end to end without a release and without touching the app under test.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A minimal bundle `open` can start: an Info.plist and an executable. `marker` tells the two apart. */
export async function writeStandInBundle(bundle: string, marker: string): Promise<void> {
	await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
	await fs.mkdir(path.join(bundle, "Contents", "Resources"), { recursive: true });
	await fs.writeFile(
		path.join(bundle, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>stand-in</string>
<key>CFBundleIdentifier</key><string>com.seuput.ompdesk.e2e-stand-in</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
	);
	await fs.writeFile(path.join(bundle, "Contents", "MacOS", "stand-in"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	await fs.writeFile(path.join(bundle, "Contents", "Resources", "marker"), marker);
}

/**
 * The environment of a launch with a staged update `version`, the stand-in at `<root>/apps/Stand-in.app` (marker
 * `old`) and the staged bundle under `<desktop>/updates/<version>` (marker `new`); `countdownMs` shortens the notice.
 */
export async function stagedUpdateEnv(
	root: string,
	desktop: string,
	version: string,
	countdownMs: number,
): Promise<{ env: Record<string, string>; ownBundle: string; swapLog: string }> {
	const ownBundle = path.join(root, "apps", "Stand-in.app");
	const staged = path.join(desktop, "updates", version, "Stand-in.app");
	await writeStandInBundle(ownBundle, "old");
	await writeStandInBundle(staged, "new");
	return {
		ownBundle,
		swapLog: path.join(desktop, "updates", "swap.log"),
		env: {
			OMP_DEV_UPDATE_MODE: "relaunch",
			OMP_DEV_UPDATE_BUNDLE: ownBundle,
			OMP_DEV_UPDATE_STAGED: staged,
			OMP_DEV_UPDATE_STAGED_VERSION: version,
			OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS: String(countdownMs),
		},
	};
}
