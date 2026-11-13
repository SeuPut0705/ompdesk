/**
 * A stand-in for OMPdesk's own bundle in the relaunch install mode (macOS): `OMP_DEV_UPDATE_BUNDLE` names the bundle
 * the update's swap replaces and `OMP_DEV_UPDATE_STAGED` a verified update already staged, so an automatic install
 * runs end to end without a release and without touching the app under test.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** What a stand-in does when `open` starts it (it always exits at once). */
export interface StandInStart {
	/** Gets one line, the bundle's `marker`, at every start: which bundle ran, and how often. */
	launchLog?: string;
	/**
	 * The start mark a real app writes once its first page loaded (`<userData>/app-started.json`, by rename), for
	 * `version`: what the swap helper waits for. Absent: an app that dies before its first page.
	 */
	startMark?: { file: string; version: string };
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

function standInScript(marker: string, start: StandInStart): string {
	const lines = ["#!/bin/sh"];
	if (start.launchLog) lines.push(`echo ${shellQuote(marker)} >> ${shellQuote(start.launchLog)}`);
	if (start.startMark) {
		const { file, version } = start.startMark;
		lines.push(
			`printf '{"version":"%s","pid":%s,"at":%s000}' ${shellQuote(version)} "$$" "$(date +%s)" > ${shellQuote(`${file}.tmp`)}`,
			`mv ${shellQuote(`${file}.tmp`)} ${shellQuote(file)}`,
		);
	}
	lines.push("exit 0", "");
	return lines.join("\n");
}

/** A minimal bundle `open` can start: an Info.plist and an executable. `marker` tells the two apart. */
export async function writeStandInBundle(bundle: string, marker: string, start: StandInStart = {}): Promise<void> {
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
	await fs.writeFile(path.join(bundle, "Contents", "MacOS", "stand-in"), standInScript(marker, start), {
		mode: 0o755,
	});
	await fs.writeFile(path.join(bundle, "Contents", "Resources", "marker"), marker);
}

/** How the staged update behaves once the swap helper reopens it. */
export interface StagedStart {
	/** `marks` (default): it writes the start mark for `version`. `dies`: it exits without one, as an app that cannot start. */
	staged?: "marks" | "dies";
	/** `OMPDESK_SWAP_START_WAIT_S` for the helper (the app passes its environment on); absent: the helper's 120 s. */
	startWaitSeconds?: number;
}

/**
 * The environment of a launch with a staged update `version`, the stand-in at `<root>/apps/Stand-in.app` (marker
 * `old`) and the staged bundle under `<desktop>/updates/<version>` (marker `new`); `countdownMs` shortens the notice.
 * `desktop` is the app's userData. Both stand-ins log their marker to `launchLog` when started; the staged one writes
 * the start mark (`markFile`) unless `start.staged` is `dies`.
 */
export async function stagedUpdateEnv(
	root: string,
	desktop: string,
	version: string,
	countdownMs: number,
	start: StagedStart = {},
): Promise<{ env: Record<string, string>; ownBundle: string; swapLog: string; launchLog: string; markFile: string }> {
	const ownBundle = path.join(root, "apps", "Stand-in.app");
	const staged = path.join(desktop, "updates", version, "Stand-in.app");
	const launchLog = path.join(root, "stand-in-launches.log");
	const markFile = path.join(desktop, "app-started.json");
	await writeStandInBundle(ownBundle, "old", { launchLog });
	await writeStandInBundle(staged, "new", {
		launchLog,
		...(start.staged === "dies" ? {} : { startMark: { file: markFile, version } }),
	});
	return {
		ownBundle,
		launchLog,
		markFile,
		swapLog: path.join(desktop, "updates", "swap.log"),
		env: {
			OMP_DEV_UPDATE_MODE: "relaunch",
			OMP_DEV_UPDATE_BUNDLE: ownBundle,
			OMP_DEV_UPDATE_STAGED: staged,
			OMP_DEV_UPDATE_STAGED_VERSION: version,
			OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS: String(countdownMs),
			...(start.startWaitSeconds === undefined ? {} : { OMPDESK_SWAP_START_WAIT_S: String(start.startWaitSeconds) }),
		},
	};
}
