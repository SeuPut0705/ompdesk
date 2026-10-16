#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * A stand-in for the `tailscale` CLI that Mobile web drives (`src/main/tailscale/`). It never touches a real
 * daemon: it reads a JSON scenario, answers from it (`answer` in `src/main/tailscale/test-fake-tailscale.ts`, the
 * same code the vitest suites run), writes the scenario back where the real command would change the daemon
 * (`serve`, `up`), and records every call, so a spec can assert what the app ran.
 *
 * Install it with `fixtureTailscale(dir)` (`fake-tailscale-install.ts`), which writes a launcher (an executable
 * script on POSIX, `tailscale.cmd` on Windows, in a folder with a space) plus a second one that stands in for
 * "open the Tailscale app", and returns the environment to launch the app with. Variables, all set by that helper:
 *
 * - `OMP_GUI_TAILSCALE`: the CLI the app uses instead of searching the machine (this file's launcher).
 * - `OMP_GUI_TEST_TAILSCALE_OPEN`: what the app runs for "start the Tailscale app" (`open -a Tailscale` on a real
 *   Mac), so a test never opens the user's own Tailscale. It starts the fake daemon: `daemon: "up"` and
 *   `backendState: <afterStart>` (default `Running`).
 * - `FAKE_TAILSCALE_STATE`: the scenario file (`FakeTailscaleScenario`). Edit it between steps (sign in:
 *   `backendState: "Running"`; enable HTTPS: `httpsEnabled: true`; quit the app: `daemon: "down"`). Default scenario:
 *   signed in, HTTPS on, an iPhone of the same user online, and the user's own
 *   `https://laptop.tail1234.ts.net:443 → http://127.0.0.1:3010` handler.
 * - `FAKE_TAILSCALE_LOG`: one JSON line per call (`{argv, beCli, code}`), `readFakeInvocations(file)`. Specs
 *   assert that no call ever was `serve reset` or a `funnel` command, and that the user's 443 → 3010 is untouched.
 *
 * Answers: `version`; `status --json`; `serve status --json`; `serve --bg --https=<port> <target>` (adds the TCP and
 * Web entries; fails with the "enable HTTPS" page when `httpsEnabled` is false, or with `serveError`);
 * `serve --https=<port> off`; `up [--json]` (`Stopped` → Running unless `upResult` is `stay`; `NeedsLogin` prints
 * `authUrl`); `debug prefs`. `serve reset`, `funnel` and anything else exit 99/1 so a regression is loud.
 */
import { appendFileSync } from "node:fs";
import { answer, startFakeApp } from "../../src/main/tailscale/test-fake-tailscale";
import { readTailscaleScenario, writeTailscaleScenario } from "./tailscale-scenario";

const stateFile = process.env.FAKE_TAILSCALE_STATE;
const logFile = process.env.FAKE_TAILSCALE_LOG;
if (!stateFile) {
	console.error("fake-tailscale: FAKE_TAILSCALE_STATE is not set");
	process.exit(2);
}
const argv = process.argv.slice(2);

function finish(code: number, stdout = "", stderr = ""): never {
	if (logFile) {
		appendFileSync(logFile, `${JSON.stringify({ argv, beCli: process.env.TAILSCALE_BE_CLI ?? null, code })}\n`);
	}
	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);
	process.exit(code);
}

const scenario = readTailscaleScenario(stateFile);
if (argv[0] === "__start-app") {
	startFakeApp(scenario);
	writeTailscaleScenario(stateFile, scenario);
	finish(0);
}
const result = answer(argv, scenario);
if (result.changed) writeTailscaleScenario(stateFile, scenario);
finish(result.code, result.stdout, result.stderr);
