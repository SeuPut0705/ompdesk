/**
 * Installers (curl | bash, PowerShell, winget, brew) neither watch stdin nor
 * die with the app. Each one therefore runs under a tiny supervisor: this
 * script, run by the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`; the
 * plain `node`/`bun` binary in tests and scripts). It starts the installer in
 * its own process group, passes its output through, and kills the installer's
 * whole tree when its stdin closes — a cancel (main ends stdin), an app quit,
 * or a crash of the app that skips every quit handler.
 *
 * The installer command comes from `OMPDESK_SETUP_SPEC` (`{file, args, shell}`
 * JSON), never from argv, so runtimes that parse argv differently agree.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { SpawnSpec } from "./plans";

export const SUPERVISOR_SPEC_ENV = "OMPDESK_SETUP_SPEC";

/** Exit code the supervisor reports after it killed the installer for a stdin close. */
export const SUPERVISOR_STOPPED_CODE = 130;

export const SUPERVISOR_SOURCE = `
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.env.${SUPERVISOR_SPEC_ENV});
delete process.env.${SUPERVISOR_SPEC_ENV};
delete process.env.ELECTRON_RUN_AS_NODE;
const windows = process.platform === "win32";
let stopping = false;
let child;
try {
	child = spawn(spec.file, spec.args, {
		stdio: ["ignore", "inherit", "inherit"],
		detached: !windows,
		shell: spec.shell === true,
		windowsHide: true,
	});
} catch (error) {
	process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
	process.exit(127);
}
function killTree(signal) {
	if (!child.pid) return;
	if (windows) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.on("error", () => child.kill());
		return;
	}
	try { process.kill(-child.pid, signal); } catch {}
}
function stop() {
	if (stopping) return;
	stopping = true;
	killTree("SIGTERM");
	setTimeout(() => killTree("SIGKILL"), 2000).unref();
}
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", error => {
	process.stderr.write(error.message + "\\n");
	process.exit(127);
});
child.on("exit", (code, signal) => {
	// A descendant that outlived the installer goes with its group.
	if (!windows) killTree("SIGKILL");
	process.exit(stopping ? ${SUPERVISOR_STOPPED_CODE} : code === null ? 1 : code);
});
`;

/** Start `spec` under the supervisor with `env`; stdin stays open until a cancel. */
export function spawnSupervised(spec: SpawnSpec, env: NodeJS.ProcessEnv): ChildProcess {
	return spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
		env: { ...env, ELECTRON_RUN_AS_NODE: "1", [SUPERVISOR_SPEC_ENV]: JSON.stringify(spec) },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
}
