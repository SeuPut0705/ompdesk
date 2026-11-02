/**
 * The parity sheet: `bun run parity -- <surface…> [--out <dir>]`.
 *
 * Captures each named surface of e2e/responsive-surfaces.ts (one with a `parity` session) the same way three times,
 * on the same session of one computer: its own desktop window, a paired computer's view of it from its section of the
 * sidebar, and its phone page at 390×844, then puts the three side by side in one sheet per surface
 * (e2e/parity.e2e.ts). Builds `out/` first (reused when unchanged), runs the capture under the machine-wide lock and
 * prints every file it wrote. Exits non-zero when any view of any surface could not be captured: there is never a
 * partial set without a failure.
 *
 * Output: `<dir>/<surface>/{local,remote,phone,sheet}.png` and `<dir>/parity.json`; default dir
 * `tmp/parity/<date>-<time>` (gitignored).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SURFACES } from "../e2e/responsive-surfaces";

const capable = SURFACES.filter(surface => surface.parity).map(surface => surface.id);
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = path.resolve(
	outAt >= 0
		? (args[outAt + 1] ?? "")
		: path.join("tmp", "parity", new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 17)),
);
const ids = args.filter((arg, index) => arg !== "--" && arg !== "--out" && (outAt < 0 || index !== outAt + 1));

if (ids.length === 0 || (outAt >= 0 && !args[outAt + 1])) {
	console.error(`usage: bun run parity -- <surface…> [--out <dir>]\nsurfaces: ${capable.join(", ")}`);
	process.exit(2);
}
const unknown = ids.filter(id => !capable.includes(id));
if (unknown.length > 0) {
	console.error(
		`[parity] no parity capture for ${unknown.join(", ")}. Surfaces with one: ${capable.join(", ")}.\n` +
			"A surface gets one with a `parity` session in e2e/responsive-surfaces.ts, once its `open` works on a real window.",
	);
	process.exit(2);
}

async function run(command: string[], env: Record<string, string> = {}): Promise<number> {
	const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...env } });
	return await child.exited;
}

await fs.mkdir(out, { recursive: true });
const manifest = path.join(out, "parity.json");
await fs.rm(manifest, { force: true });

if ((await run(["bun", "run", "build"])) !== 0) {
	console.error("[parity] the build failed: nothing captured");
	process.exit(1);
}
const code = await run(
	[
		"bun",
		"run",
		"locked",
		"--",
		"bunx",
		"playwright",
		"test",
		"e2e/parity.e2e.ts",
		"--trace",
		"off",
		"--reporter",
		"line",
		"--output",
		path.join(out, "results"),
	],
	{ OMP_GUI_PARITY: out, OMP_GUI_PARITY_ONLY: ids.join(",") },
);

interface Manifest {
	surfaces: Array<{ id: string; sheet?: string; shots: Record<string, string>; failures: string[] }>;
	pageErrors: string[];
}
const written = await fs
	.readFile(manifest, "utf8")
	.then(text => JSON.parse(text) as Manifest)
	.catch(() => null);
if (!written) {
	console.error(`[parity] FAILED: the capture wrote no ${manifest} (Playwright exited ${code}; its output is above)`);
	process.exit(1);
}
let failed = code !== 0;
for (const id of ids) {
	const surface = written.surfaces.find(entry => entry.id === id);
	if (surface?.sheet && surface.failures.length === 0) {
		console.log(`[parity] ${id}: ${surface.sheet}`);
		for (const [view, file] of Object.entries(surface.shots)) console.log(`[parity]   ${view}: ${file}`);
		continue;
	}
	failed = true;
	console.error(`[parity] FAILED ${id}: ${surface ? surface.failures.join("; ") || "no sheet" : "never captured"}`);
}
for (const error of written.pageErrors) console.warn(`[parity] page error: ${error}`);
process.exit(failed ? 1 : 0);
