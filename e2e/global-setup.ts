import { assertAppBuilt } from "../scripts/e2e-app-entry";
import { assertShellBuilt } from "./fixture/shell-launch";

// Runs once, before any worker: a missing build (the app's `out/`, or the shell that runs it) fails the whole run here
// instead of every test's launch failing on its own (scripts/e2e-app-entry.ts, e2e/fixture/shell-launch.ts).
export default function globalSetup(): void {
	assertAppBuilt();
	assertShellBuilt();
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (process.platform === "win32" && major === 24 && minor < 16) {
		console.warn(
			`Node ${process.versions.node} (libuv 1.51) can kill a Playwright worker with 0xC0000409 on a loopback connect (nodejs/node#63620, fixed in 24.16.0): a test then fails with "worker process exited unexpectedly". Install Node 24.16 or later (docs/windows-dev.md).`,
		);
	}
}
