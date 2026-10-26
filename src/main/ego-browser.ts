/**
 * Is ego-browser (ego lite, the browser the Default browser setting points agents at) installed? Looked up on the
 * spawn PATH like `resolveBin`, plus `~/.local/bin`, where ego's installer puts it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnPath } from "./shell-env";
import { findOnPath } from "./spawn";

const BIN = "ego-browser";

let cached: Promise<string | null> | null = null;

/** Absolute path to `ego-browser`, or null when not installed. Found once per launch; a miss is re-probed next call. */
export function resolveEgoBrowser(): Promise<string | null> {
	if (!cached) {
		const platform = process.platform;
		const names = platform === "win32" ? [`${BIN}.exe`, `${BIN}.cmd`, BIN] : [BIN];
		const localBin = join(homedir(), ".local", "bin");
		const pending = spawnPath().then(pathEnv =>
			findOnPath(
				names,
				pathEnv,
				platform,
				names.map(name => join(localBin, name)),
			),
		);
		cached = pending;
		void pending.then(
			bin => {
				if (!bin && cached === pending) cached = null;
			},
			() => {
				if (cached === pending) cached = null;
			},
		);
	}
	return cached;
}

export async function egoBrowserInstalled(): Promise<boolean> {
	return (await resolveEgoBrowser().catch(() => null)) !== null;
}
