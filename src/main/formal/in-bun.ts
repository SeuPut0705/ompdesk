import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKILL =
	process.env.FORMAL_SKILL_DIR ??
	path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");

let scripts = 0;

/**
 * Runs `body` (module code, top-level await allowed; `lib(name)` imports a script lib of the skill) in a Bun child and
 * returns what it printed. The skill's install lock needs bun:ffi, which vitest's Node does not have, so a test that
 * takes the lock (directly, or through prepareTla) runs its code here.
 */
export function inBun(
	dir: string,
	body: string,
	env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
	const script = path.join(dir, `in-bun-${++scripts}.ts`);
	const libDir = JSON.stringify(path.join(SKILL, "scripts/lib"));
	fs.writeFileSync(script, `const lib = (name) => import(${libDir} + "/" + name + ".ts");\n${body}`);
	const run = spawnSync("bun", [script], { encoding: "utf8", env });
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
