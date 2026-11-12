#!/usr/bin/env bun
/**
 * What a command leaves in the temp folder, as a number: `bun scripts/temp-leftovers.ts [--base <dir>] [--settle <ms>]
 * <command…>` runs the command with TEMP, TMP and TMPDIR pointed at a folder of its own and lists what is still in it
 * once the command has ended, by kind. A folder of its own, not a before/after listing of the real temp folder,
 * because other sessions on the machine write there all the time.
 *
 * `--base <dir>` keeps the folder for a second command (a killed run, then the run that sweeps it); without it the
 * folder is removed after the listing. The exit code is the command's.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { groupEntries } from "./run-temp";

// Options come first; the command is everything after them (bun drops a `--` in front of it, so none is needed).
const args = process.argv.slice(2);
const flags: Record<string, string | undefined> = {};
while (args[0] === "--base" || args[0] === "--settle") flags[args.shift() as string] = args.shift();
if (args.length === 0) {
	console.error("usage: bun scripts/temp-leftovers.ts [--base <dir>] [--settle <ms>] <command…>");
	process.exit(2);
}
const kept = flags["--base"];
const base = kept ? path.resolve(kept) : fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-leftovers-"));
fs.mkdirSync(base, { recursive: true });
const before = new Set(fs.readdirSync(base));
const result = spawnSync(args[0] as string, args.slice(1), {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: { ...process.env, TEMP: base, TMP: base, TMPDIR: base },
});
// A fake that ends itself once its test is gone looks every 2 s (scripts/vitest-orphan-guard.ts).
Bun.sleepSync(Number(flags["--settle"] ?? 5000));
const all = fs.readdirSync(base);
const left = all.filter(name => !before.has(name));
console.log(`\n[temp-leftovers] ${left.length} entries left in ${base} by: ${args.join(" ")}`);
for (const [kind, count] of groupEntries(left)) console.log(`  ${String(count).padStart(5)}  ${kind}`);
if (before.size > 0) console.log(`  (${all.length - left.length} of the ${before.size} entries there before remain)`);
if (!kept) fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(result.status ?? 1);
