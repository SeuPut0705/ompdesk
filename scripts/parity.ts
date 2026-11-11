/**
 * The parity sheet: `bun run parity -- <surface…> [--out <dir>]`, or `bun run parity -- --both-orders [--out <dir>]`.
 *
 * Captures each named surface of e2e/responsive-surfaces.ts (one with a `parity` session) the same way three times,
 * on the same session of one computer: its own desktop window, a paired computer's view of it from its section of the
 * sidebar, and its phone page at 390×844, then puts the three side by side in one sheet per surface
 * (e2e/parity.e2e.ts). Builds `out/` first (reused when unchanged), runs the capture under the machine-wide lock and
 * prints every file it wrote. Exits non-zero when any view of any surface could not be captured: there is never a
 * partial set without a failure.
 *
 * `--both-orders` is the order check: every parity surface in one capture and all of them again in reverse order in
 * another, into `<dir>/forward` and `<dir>/reverse`. The surfaces of one capture share its two apps, so a surface that
 * leaves something behind breaks one that comes after it; one order alone cannot tell. The two captures are two tests
 * of one Playwright run, side by side where the machine gives the run two workers (each has its own apps).
 *
 * Output: `<dir>/<surface>/{local,remote,phone,sheet}.png` and `<dir>/parity.json`; default dir
 * `tmp/parity/<date>-<time>` (gitignored).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SURFACES } from "../e2e/responsive-surfaces";

const capable = SURFACES.filter(surface => surface.parity && surface.parity.available?.() !== false).map(
	surface => surface.id,
);
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const bothOrders = args.includes("--both-orders");
const out = path.resolve(
	outAt >= 0
		? (args[outAt + 1] ?? "")
		: path.join("tmp", "parity", new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 17)),
);
const ids = args.filter(
	(arg, index) => arg !== "--" && arg !== "--out" && arg !== "--both-orders" && (outAt < 0 || index !== outAt + 1),
);
const misused = bothOrders ? ids.length > 0 : ids.length === 0;
if (misused || (outAt >= 0 && !args[outAt + 1])) {
	console.error(
		`usage: bun run parity -- <surface…> [--out <dir>]\n       bun run parity -- --both-orders [--out <dir>]\nsurfaces: ${capable.join(", ")}`,
	);
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

interface Manifest {
	surfaces: Array<{ id: string; sheet?: string; shots: Record<string, string>; failures: string[] }>;
	pageErrors: string[];
}

/** Runs the capture spec once under the machine-wide lock; `env` says what it captures and where. */
async function playwright(dir: string, env: Record<string, string>): Promise<number> {
	return await run(
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
			path.join(dir, "results"),
		],
		env,
	);
}

/** Forgets what an earlier capture wrote to `dir`, so a capture that writes nothing is not read as that one. */
async function prepare(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.rm(path.join(dir, "parity.json"), { force: true });
}

/** Prints what the capture in `dir` wrote; false when any of `surfaces` lacks a view, or the capture wrote nothing. */
async function report(surfaces: readonly string[], dir: string): Promise<boolean> {
	const manifest = path.join(dir, "parity.json");
	const written = await fs
		.readFile(manifest, "utf8")
		.then(text => JSON.parse(text) as Manifest)
		.catch(() => null);
	if (!written) {
		console.error(`[parity] FAILED: the capture wrote no ${manifest} (Playwright's output is above)`);
		return false;
	}
	let ok = true;
	for (const id of surfaces) {
		const surface = written.surfaces.find(entry => entry.id === id);
		if (surface?.sheet && surface.failures.length === 0) {
			console.log(`[parity] ${id}: ${surface.sheet}`);
			for (const [view, file] of Object.entries(surface.shots)) console.log(`[parity]   ${view}: ${file}`);
			continue;
		}
		ok = false;
		console.error(`[parity] FAILED ${id}: ${surface ? surface.failures.join("; ") || "no sheet" : "never captured"}`);
	}
	for (const error of written.pageErrors) console.warn(`[parity] page error: ${error}`);
	return ok;
}

await fs.mkdir(out, { recursive: true });
if ((await run(["bun", "run", "build"])) !== 0) {
	console.error("[parity] the build failed: nothing captured");
	process.exit(1);
}
if (!bothOrders) {
	await prepare(out);
	const code = await playwright(out, { OMP_GUI_PARITY: out, OMP_GUI_PARITY_ONLY: ids.join(",") });
	const captured = await report(ids, out);
	if (captured && code !== 0) console.error(`[parity] FAILED: Playwright exited ${code} (its output is above)`);
	process.exit(captured && code === 0 ? 0 : 1);
}

const orders = ["forward", "reverse"] as const;
for (const order of orders) await prepare(path.join(out, order));
const code = await playwright(out, { OMP_GUI_PARITY: out, OMP_GUI_PARITY_ORDERS: "both" });
const failed: string[] = [];
for (const order of orders) {
	console.log(`[parity] ${order}:`);
	if (!(await report(capable, path.join(out, order)))) failed.push(order);
}
if (failed.length > 0) {
	console.error(`[parity] FAILED in ${failed.join(" and ")} order: a surface left something behind for one after it`);
	process.exit(1);
}
if (code !== 0) {
	console.error(`[parity] FAILED: Playwright exited ${code} (its output is above)`);
	process.exit(1);
}
console.log(`[parity] every surface passed in both orders: ${out}`);
