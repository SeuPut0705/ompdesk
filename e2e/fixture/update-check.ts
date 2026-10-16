import * as fs from "node:fs";
import * as nodePath from "node:path";
import { FIXTURE_OMP_VERSION } from "./version";

/** Stock `omp update --check`. */
export function runUpdateCheck(): void {
	// Stock's check: `OMP_GUI_TEST_LATEST_OMP` is the registry's newest (default: this version).
	// `OMP_GUI_TEST_UPDATE_CHECK_LOG=<file>` gets one line per check: the first PATH entry, the `omp`
	// stock's `update` would resolve (`$which("omp")`).
	const latest = process.env.OMP_GUI_TEST_LATEST_OMP || FIXTURE_OMP_VERSION;
	if (process.env.OMP_GUI_TEST_UPDATE_CHECK_LOG) {
		const first = (process.env.PATH ?? "").split(nodePath.delimiter)[0] ?? "";
		fs.appendFileSync(process.env.OMP_GUI_TEST_UPDATE_CHECK_LOG, `${first}\n`);
	}
	const newer = latest.localeCompare(FIXTURE_OMP_VERSION, undefined, { numeric: true }) > 0;
	console.log(
		`Current version: ${FIXTURE_OMP_VERSION}\n${newer ? `New version available: ${latest}` : "Already up to date"}`,
	);
}
