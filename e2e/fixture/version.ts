import * as fs from "node:fs";

/**
 * The version this fake omp reports: `OMP_GUI_TEST_VERSION_FILE`'s text once that file exists (a fake
 * installer writes it, i.e. "omp updated"), else FIXTURE_MIN_OMP_VERSION (MIN_OMP_VERSION).
 * `OMP_GUI_TEST_UNAVAILABLE_AFTER_UPDATE=<feature>` makes the bridge's capabilities probe report that feature
 * missing on any version but FIXTURE_MIN_OMP_VERSION.
 * `OMP_GUI_TEST_BOOT_LOG=<file>` gets one line (the version) per `--mode rpc-ui` boot.
 */
export const FIXTURE_MIN_OMP_VERSION = "18.12.6";
export const FIXTURE_OMP_VERSION = (() => {
	const file = process.env.OMP_GUI_TEST_VERSION_FILE;
	return (file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "") || FIXTURE_MIN_OMP_VERSION;
})();
