// Run by `e2e/app-lifetime.e2e.ts` under node: launches the app the way a Playwright worker does
// (`launchShell`, with the `{args, env}` `appLaunchOptions` built in the worker, file argv[2]), waits until its
// omp is ready, prints the app's main pid and dies at once, running no exit handler (as a crashed or killed worker
// does: Node 24.15's 0xC0000409 on Windows, an outer `taskkill /F`).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Plain Node resolves a TypeScript file only by its extension, which `tsc` refuses in a static import.
const { launchShell } = (await import(
	new URL("./shell-launch.ts", import.meta.url).href
)) as typeof import("./shell-launch");

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as {
	args: string[];
	env: Record<string, string>;
};
// This process stands in for the worker that built the options: the launcher pid they name (the worker's) is pointed
// at it. Only re-pointed, never added, so a launch path that sets no launcher pid fails the test.
const env = { ...options.env };
if (env.OMP_GUI_TEST_LAUNCHER_PID) env.OMP_GUI_TEST_LAUNCHER_PID = String(process.pid);
const app = await launchShell({ ...options, env });
const page = await app.firstWindow();
const deadline = Date.now() + 60_000;
while ((await page.evaluate(() => window.omp.sidecar.getStatus())).status !== "ready") {
	if (Date.now() > deadline) throw new Error("the app's omp never became ready");
	await sleep(200);
}
const pid = await app.evaluate(() => process.pid);
process.stdout.write(`APP_PID ${pid}\n`, () => process.kill(process.pid, "SIGKILL"));
