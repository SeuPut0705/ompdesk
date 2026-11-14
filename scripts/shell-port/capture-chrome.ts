/**
 * Captures the TypeScript that batch SX1 moves into the shell's `chrome` module (PROTOCOL.md §15.3): each area module in
 * `capture-chrome/` drives the code through its public functions (over `fake-shell.ts` where it speaks to Electron) and
 * returns its steps; this writes each area to `native/ompdesk/crates/shell/src/chrome_core/captured/<area>.json`, headed
 * by the commit the TypeScript was read at. `cargo test` replays the files against `chrome_core`.
 *
 *   bun scripts/shell-port/capture-chrome.ts <area>[,<area>…]
 *
 * Run it while the TypeScript of that area still exists.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plugin } from "bun";
import { current } from "./capture-chrome/electron-module";
import { fakeShell } from "./capture-chrome/fake-shell";

/** One recorded step: what a public function was given and what it returned or sent. */
export interface Step {
	/** The function or scenario, `<file>#<name>`. */
	fn: string;
	input: unknown;
	output: unknown;
}

export type Capture = () => Promise<Step[]>;

const AREAS = ["window", "menu", "tray", "quit", "deeplink", "hang", "gpu"] as const;
type Area = (typeof AREAS)[number];

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "native", "ompdesk", "crates", "shell", "src", "chrome_core", "captured");

// The modules under capture import `electron` (the shim over the current fake shell) and Vite's `?inline` assets.
plugin({
	name: "capture-chrome",
	setup(build) {
		build.module("electron", () => ({ exports: current(), loader: "object" }));
		build.onResolve({ filter: /\?inline$/ }, args => ({
			path: join(args.resolveDir ?? dirname(args.importer), args.path.replace(/\?inline$/, "")),
			namespace: "inline-asset",
		}));
		build.onLoad({ filter: /.*/, namespace: "inline-asset" }, args => ({
			exports: { default: `data:image/png;base64,${readFileSync(args.path).toString("base64")}` },
			loader: "object",
		}));
	},
});

function areasToRun(): Area[] {
	const names = (process.argv[2] ?? "").split(",").filter(Boolean);
	if (names.length === 0) throw new Error(`name the areas to capture: ${AREAS.join(", ")}`);
	for (const name of names) {
		if (!(AREAS as readonly string[]).includes(name))
			throw new Error(`unknown area ${name}; areas: ${AREAS.join(", ")}`);
	}
	return names as Area[];
}

// Module top levels (electron-store's `prefs` in i18n.ts) read `electron` while they load: a shell is current first.
await fakeShell();

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
for (const area of areasToRun()) {
	// Loaded only after the plugin above exists: the area modules (and the code they capture) import `electron`.
	const module: { capture: Capture } = await import(`./capture-chrome/${area}.ts`);
	const steps = await module.capture();
	const file = join(OUT, `${area}.json`);
	writeFileSync(file, `${JSON.stringify({ capturedFrom: commit, steps }, null, "\t")}\n`);
	console.log(`${area}: ${steps.length} steps → ${file}`);
}
process.exit(0);
