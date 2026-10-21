// Run by `e2e/app-lifetime.e2e.ts` under node: launches the app the way a Playwright worker does
// (`_electron.launch`, stdin piped from this process), waits until its omp is ready, prints the app's main pid
// and dies at once, running no exit handler (as a crashed or killed worker does: Node 24.15's 0xC0000409 on
// Windows, an outer `taskkill /F`). argv[2] is a JSON file holding `{args, env}` from `appLaunchOptions`.
import { readFileSync } from "node:fs";
import { _electron as electron } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as {
	args: string[];
	env: Record<string, string>;
};
const app = await electron.launch(options);
const page = await app.firstWindow();
const deadline = Date.now() + 60_000;
while ((await page.evaluate(() => window.omp.sidecar.getStatus())).status !== "ready") {
	if (Date.now() > deadline) throw new Error("the app's omp never became ready");
	await sleep(200);
}
const pid = await app.evaluate(() => process.pid);
process.stdout.write(`APP_PID ${pid}\n`, () => process.kill(process.pid, "SIGKILL"));
