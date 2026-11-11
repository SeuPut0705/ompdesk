import * as fs from "node:fs";

/**
 * The version this fake omp reports: `OMP_GUI_TEST_VERSION_FILE`'s text once that file exists (a fake
 * installer writes it, i.e. "omp updated"), else FIXTURE_MIN_OMP_VERSION (MIN_OMP_VERSION, which
 * `version.test.ts` holds it to: the fake stays free of the app's modules).
 * `OMP_GUI_TEST_UNAVAILABLE_AFTER_UPDATE=<feature>` makes the bridge's capabilities probe report that feature
 * missing on any version but FIXTURE_MIN_OMP_VERSION.
 * `OMP_GUI_TEST_BOOT_LOG=<file>` gets one line (the version) per `--mode rpc-ui` boot.
 */
export const FIXTURE_MIN_OMP_VERSION = "18.18.9";
/** A release after the floor, for the scenarios that update the fake omp: the floor's next minor. */
export const FIXTURE_NEWER_OMP_VERSION = (() => {
	const [major = 0, minor = 0] = FIXTURE_MIN_OMP_VERSION.split(".").map(Number);
	return `${major}.${minor + 1}.0`;
})();
export const FIXTURE_OMP_VERSION = (() => {
	const file = process.env.OMP_GUI_TEST_VERSION_FILE;
	return (file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "") || FIXTURE_MIN_OMP_VERSION;
})();
