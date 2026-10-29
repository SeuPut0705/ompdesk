import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";

// The control socket (src/main/control-socket) and the `ompdesk` CLI (resources/cli): a shell outside any session
// drives the built app through the launcher OMPdesk writes into `<userData>/bin`, against the fake omp.

let app: ElectronApplication;
let profile: string;
let desktop: string;
let project: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-cli-"));
	project = path.join(profile, "project");
	desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_HEADLESS: "1" } });
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** `ompdesk <args>` from a plain shell: the launcher on PATH, this test's app found through its control folder. */
function ompdesk(...args: string[]): Promise<Run> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${path.join(desktop, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
		OMPDESK_CONTROL_DIR: path.join(desktop, "control"),
	};
	// A test run from inside an OMPdesk session must never reach that app.
	delete env.OMPDESK_SOCKET;
	delete env.OMPDESK_CALLER;
	const { promise, resolve } = Promise.withResolvers<Run>();
	execFile(
		"/bin/sh",
		["-c", 'exec ompdesk "$@"', "ompdesk", ...args],
		{ env, cwd: project, timeout: 90_000 },
		(error, stdout, stderr) => {
			const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
			resolve({ code, stdout, stderr });
		},
	);
	return promise;
}

test.skip(process.platform === "win32", "the launcher is run through /bin/sh");

test("a shell opens a session, sends it a prompt, waits until it is idle and reads the answer", async () => {
	test.setTimeout(150_000);
	await expect
		.poll(() =>
			fs.stat(path.join(desktop, "control", "endpoint.json")).then(
				() => true,
				() => false,
			),
		)
		.toBe(true);

	const opened = await ompdesk("open", "--show", "background");
	expect(opened, opened.stderr).toMatchObject({ code: 0 });
	const session = /Opened session (\w+)/.exec(opened.stdout)?.[1] ?? "";
	expect(session).not.toBe("");

	const sent = await ompdesk(
		"send",
		session,
		"Summarize the repo",
		"--wait",
		"--until",
		"idle",
		"--timeout",
		"60",
		"--json",
	);
	expect(sent, sent.stderr).toMatchObject({ code: 0 });
	const result = JSON.parse(sent.stdout) as { receipt: string; waited: { session: string; state: string } };
	expect(result.receipt).toContain("Sent to");
	expect(result.waited).toMatchObject({ session, state: "idle" });

	const state = await ompdesk("state", session, "--json");
	expect(JSON.parse(state.stdout)).toMatchObject({ session, state: "idle" });

	const read = await ompdesk("read", session);
	expect(read, read.stderr).toMatchObject({ code: 0 });
	expect(read.stdout).toContain("Summarize the repo");
	expect(read.stdout).toContain("[assistant] Local fixture reply");

	await exitApp(app);
	const gone = await ompdesk("sessions");
	expect(gone.code).toBe(3);
	expect(gone.stderr).toContain("OMPdesk");
});
