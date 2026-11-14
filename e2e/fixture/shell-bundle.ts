/**
 * The macOS shell runs from an `.app` bundle only: CEF loads `Chromium Embedded Framework` from `../Frameworks` of the
 * executable and starts its helper processes from `Contents/Frameworks/<product> Helper*.app`, so the unbundled
 * `resources/ompdesk-shell/darwin-<arch>/ompdesk-shell` that `bun run build:shell` stages exits at once ("run the shell
 * from its .app bundle"). Before a Playwright run, `e2e/global-setup.ts` assembles a dev bundle from the staged files:
 * no app resources, no signature of its own (the shell binary keeps the linker's ad-hoc one), the app itself comes
 * from `OMPDESK_APP_DIR`/`OMPDESK_APP_ENTRY` as for an unpackaged shell on Windows. The layout is `scripts/package-mac.ts`'s
 * (`scripts/mac-bundle-info.cjs`), which is the packaged app; this is the part of it a test needs.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { devBundleApp, stagedShell } from "./shell-launch";

const require = createRequire(import.meta.url);
const plist = require("plist") as { build: (value: Record<string, unknown>) => string };
const bundle = require("../../scripts/mac-bundle-info.cjs") as {
	PRODUCT: string;
	FRAMEWORK: string;
	HELPERS: { suffix: string; id: string }[];
	appInfo: (version: string) => Record<string, unknown>;
	helperInfo: (version: string, helper: { suffix: string; id: string }) => Record<string, unknown>;
};

/** What `build:shell` records next to the staged shell (scripts/build-shell.ts `ShellBuildRecord`). */
const RECORD = "ompdesk-shell.build.json";

export interface DevBundleOptions {
	/** The staged folder (`resources/ompdesk-shell/<platform>-<arch>`). */
	staged?: string;
	/** Where the bundle goes. */
	app?: string;
	/** The version in the Info.plists. */
	version?: string;
}

/** Whether `app` was assembled from the staged build `record` describes (the record is copied into it). */
function isCurrent(app: string, record: string): boolean {
	try {
		return fs.readFileSync(path.join(app, "Contents", "Resources", RECORD), "utf8") === record;
	} catch {
		return false;
	}
}

/**
 * Make sure the dev bundle holds the staged shell and return its executable. Idempotent and safe beside other runs of
 * the same checkout: a current bundle is left alone, a new one is built beside it and moved into place, and a run that
 * loses that race uses the winner's.
 */
export function ensureDevBundle(options: DevBundleOptions = {}): string {
	const staged = options.staged ?? path.dirname(stagedShell());
	const app = options.app ?? devBundleApp();
	const recordFile = path.join(staged, RECORD);
	if (!fs.existsSync(recordFile)) {
		throw new Error(`No shell: ${recordFile} does not exist. Run \`bun run build:shell\`.`);
	}
	const record = fs.readFileSync(recordFile, "utf8");
	const executable = path.join(app, "Contents", "MacOS", bundle.PRODUCT);
	if (isCurrent(app, record) && fs.existsSync(executable)) return executable;

	const { binary } = JSON.parse(record) as { binary: string };
	const version =
		options.version ?? (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;
	const temp = `${app}.tmp-${process.pid}-${createHash("sha256").update(record).digest("hex").slice(0, 8)}`;
	fs.rmSync(temp, { recursive: true, force: true });
	const contents = path.join(temp, "Contents");
	const frameworks = path.join(contents, "Frameworks");
	for (const dir of [path.join(contents, "MacOS"), frameworks, path.join(contents, "Resources")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	// The one executable is the app and each helper (CEF starts the helpers by their names).
	const install = (to: string) => {
		fs.copyFileSync(path.join(staged, binary), to);
		fs.chmodSync(to, 0o755);
	};
	install(path.join(contents, "MacOS", bundle.PRODUCT));
	// Clone-on-write where the volume has it; symlinks stay links (`Versions/Current`).
	fs.cpSync(path.join(staged, bundle.FRAMEWORK), path.join(frameworks, bundle.FRAMEWORK), {
		recursive: true,
		verbatimSymlinks: true,
		mode: fs.constants.COPYFILE_FICLONE,
	});
	fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(bundle.appInfo(version)));
	for (const helper of bundle.HELPERS) {
		const name = `${bundle.PRODUCT} Helper${helper.suffix}`;
		const helperContents = path.join(frameworks, `${name}.app`, "Contents");
		fs.mkdirSync(path.join(helperContents, "MacOS"), { recursive: true });
		install(path.join(helperContents, "MacOS", name));
		fs.writeFileSync(path.join(helperContents, "Info.plist"), plist.build(bundle.helperInfo(version, helper)));
	}
	fs.writeFileSync(path.join(contents, "Resources", RECORD), record);

	fs.mkdirSync(path.dirname(app), { recursive: true });
	if (!isCurrent(app, record)) fs.rmSync(app, { recursive: true, force: true });
	try {
		fs.renameSync(temp, app);
	} catch (error) {
		// Another run of this checkout moved its copy in first; a bundle that is there and current is as good.
		if (!(isCurrent(app, record) && fs.existsSync(executable))) throw error;
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
	return executable;
}
