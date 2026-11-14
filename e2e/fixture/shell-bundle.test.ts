import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDevBundle } from "./shell-bundle";
import { DEV_BUNDLE_PRODUCT, devBundleApp, devBundleExecutable, shellExecutable } from "./shell-launch";

const bundleInfo = createRequire(import.meta.url)("../../scripts/mac-bundle-info.cjs") as {
	PRODUCT: string;
	FRAMEWORK: string;
	HELPERS: { suffix: string }[];
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What `build:shell` stages on macOS, in miniature. */
function stagedShell(record = "one") {
	const root = mkdtempSync(path.join(os.tmpdir(), "omp-dev-bundle-"));
	dirs.push(root);
	const staged = path.join(root, "staged");
	const framework = path.join(staged, bundleInfo.FRAMEWORK);
	mkdirSync(path.join(framework, "Versions", "A"), { recursive: true });
	writeFileSync(path.join(framework, "Versions", "A", "Chromium Embedded Framework"), "cef");
	try {
		symlinkSync("A", path.join(framework, "Versions", "Current"), "dir");
	} catch {
		// no symlink right on this machine: the layout check below does not need it
	}
	writeFileSync(path.join(staged, "ompdesk-shell"), "binary");
	writeFileSync(path.join(staged, "ompdesk-shell.build.json"), JSON.stringify({ binary: "ompdesk-shell", record }));
	return { root, staged, app: path.join(root, "bundle", "OMPdesk.app") };
}

describe("the macOS dev bundle", () => {
	it("names the product the packaged app has", () => {
		expect(DEV_BUNDLE_PRODUCT).toBe(bundleInfo.PRODUCT);
		expect(devBundleExecutable("/r", "arm64")).toBe(
			path.join(
				"/r",
				"node_modules",
				".cache",
				"ompdesk-e2e",
				"darwin-arm64",
				"OMPdesk.app",
				"Contents",
				"MacOS",
				"OMPdesk",
			),
		);
		expect(shellExecutable({}, "darwin")).toBe(devBundleExecutable());
		expect(shellExecutable({ OMP_GUI_E2E_SHELL: "/x/OMPdesk" }, "darwin")).toBe(path.resolve("/x/OMPdesk"));
		expect(devBundleApp()).toContain(path.join("node_modules", ".cache"));
	});

	it("lays the executable, the framework and the five helper apps out as CEF looks for them", () => {
		const { staged, app } = stagedShell();
		const executable = ensureDevBundle({ staged, app, version: "9.9.9" });
		expect(executable).toBe(path.join(app, "Contents", "MacOS", "OMPdesk"));
		expect(readFileSync(executable, "utf8")).toBe("binary");
		expect(
			readFileSync(
				path.join(
					app,
					"Contents",
					"Frameworks",
					bundleInfo.FRAMEWORK,
					"Versions",
					"A",
					"Chromium Embedded Framework",
				),
				"utf8",
			),
		).toBe("cef");
		expect(readFileSync(path.join(app, "Contents", "Info.plist"), "utf8")).toContain("<string>9.9.9</string>");
		expect(bundleInfo.HELPERS).toHaveLength(5);
		for (const helper of bundleInfo.HELPERS) {
			const name = `OMPdesk Helper${helper.suffix}`;
			const helperExe = path.join(app, "Contents", "Frameworks", `${name}.app`, "Contents", "MacOS", name);
			expect(readFileSync(helperExe, "utf8")).toBe("binary");
			expect(
				readFileSync(path.join(app, "Contents", "Frameworks", `${name}.app`, "Contents", "Info.plist"), "utf8"),
			).toContain(name);
		}
		if (process.platform !== "win32") expect(statSync(executable).mode & 0o111).not.toBe(0);
	});

	it("leaves a current bundle alone and replaces one built from another staged build", () => {
		const { root, staged, app } = stagedShell("one");
		const executable = ensureDevBundle({ staged, app, version: "1.0.0" });
		writeFileSync(path.join(app, "marker"), "kept");
		expect(ensureDevBundle({ staged, app, version: "1.0.0" })).toBe(executable);
		expect(readFileSync(path.join(app, "marker"), "utf8")).toBe("kept");
		writeFileSync(path.join(staged, "ompdesk-shell"), "newer binary");
		writeFileSync(
			path.join(staged, "ompdesk-shell.build.json"),
			JSON.stringify({ binary: "ompdesk-shell", record: "two" }),
		);
		ensureDevBundle({ staged, app, version: "1.0.0" });
		expect(readFileSync(executable, "utf8")).toBe("newer binary");
		expect(() => readFileSync(path.join(app, "marker"))).toThrow();
		expect(readFileSync(path.join(root, "staged", "ompdesk-shell"), "utf8")).toBe("newer binary");
	});

	it("says what to build when the shell was never staged", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "omp-dev-bundle-"));
		dirs.push(root);
		expect(() => ensureDevBundle({ staged: root, app: path.join(root, "x.app") })).toThrow("bun run build:shell");
	});
});
