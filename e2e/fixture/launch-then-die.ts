// Run by `e2e/app-lifetime.e2e.ts` under node: launches the app the way a Playwright worker does
// (`_electron.launch`, this process named as its launcher), waits until its omp is ready, prints the app's main pid
// and dies at once, running no exit handler (as a crashed or killed worker does: Node 24.15's 0xC0000409 on
// Windows, an outer `taskkill /F`). argv[2] is a JSON file holding `{args, env}` from `appLaunchOptions`.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as {
	args: string[];
	env: Record<string, string>;
};
// This process is the launcher here, as a worker is in a run (playwright.config.ts sets the worker's own pid).
const app = await electron.launch({
	...options,
	env: { ...options.env, OMP_GUI_TEST_LAUNCHER_PID: String(process.pid) },
});
const page = await app.firstWindow();
const deadline = Date.now() + 60_000;
while ((await page.evaluate(() => window.omp.sidecar.getStatus())).status !== "ready") {
	if (Date.now() > deadline) throw new Error("the app's omp never became ready");
	await sleep(200);
}
const pid = await app.evaluate(() => process.pid);
process.stdout.write(`APP_PID ${pid}\n`, () => process.kill(process.pid, "SIGKILL"));
