/**
 * Install the fake Tailscale CLI (`fake-tailscale.ts`) for one test: the scenario file, the call log, and two
 * launchers shaped like a real install (an executable script on POSIX, a `.cmd` shim on Windows, in a folder with a
 * space so path and argv quoting are exercised). `env` is what to launch the app with; the variables are
 * documented at the top of `fake-tailscale.ts`.
 *
 *     const tailscale = await fixtureTailscale(profile, { backendState: "NeedsLogin" });
 *     const app = await launchApp({ ..., env: { ...tailscale.env } });
 *     await tailscale.update({ backendState: "Running" });      // the user signed in
 *     expect(tailscale.invocations().some(call => call.argv[0] === "funnel")).toBe(false);
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	defaultTailscaleScenario,
	type FakeInvocation,
	type FakeTailscaleScenario,
	readFakeInvocations,
	readTailscaleScenario,
	writeTailscaleScenario,
} from "./tailscale-scenario";

export interface FixtureTailscale {
	/** The fake CLI (`OMP_GUI_TAILSCALE`). */
	bin: string;
	/** The "open the Tailscale app" stand-in (`OMP_GUI_TEST_TAILSCALE_OPEN`). */
	openApp: string;
	statePath: string;
	logPath: string;
	/** Environment for `launchApp({ env })`. */
	env: Record<string, string>;
	scenario(): FakeTailscaleScenario;
	/** Merge `patch` into the scenario file (the user, or the network, changed something). */
	update(patch: Partial<FakeTailscaleScenario>): void;
	invocations(): FakeInvocation[];
}

/** The launcher file's name and source for `entry` (`fake-tailscale.ts`), run by bun with `prelude` ahead of it. */
async function writeLauncher(dir: string, name: string, prelude: string[]): Promise<string> {
	const fixture = pathToFileURL(resolve("e2e/fixture/fake-tailscale.ts")).href;
	const source = [...prelude, `await import(${JSON.stringify(fixture)});`, ""].join("\n");
	const script = join(dir, `${name}.ts`);
	if (process.platform !== "win32") {
		await writeFile(script, `#!/usr/bin/env bun\n${source}`);
		await chmod(script, 0o755);
		return script;
	}
	await writeFile(script, source);
	const shim = join(dir, `${name}.cmd`);
	await writeFile(shim, `@bun "${script}" %*\r\n`);
	return shim;
}

export async function fixtureTailscale(
	dir: string,
	overrides: Partial<FakeTailscaleScenario> = {},
): Promise<FixtureTailscale> {
	const root = join(dir, "fake tailscale");
	await mkdir(root, { recursive: true });
	const statePath = join(root, "scenario.json");
	const logPath = join(root, "calls.jsonl");
	writeTailscaleScenario(statePath, defaultTailscaleScenario(overrides));
	await writeFile(logPath, "");
	const prelude = [
		`process.env.FAKE_TAILSCALE_STATE ??= ${JSON.stringify(statePath)};`,
		`process.env.FAKE_TAILSCALE_LOG ??= ${JSON.stringify(logPath)};`,
	];
	const bin = await writeLauncher(root, "tailscale", prelude);
	const openApp = await writeLauncher(root, "open-tailscale", [
		...prelude,
		`process.argv.splice(2, 0, "__start-app");`,
	]);
	return {
		bin,
		openApp,
		statePath,
		logPath,
		env: {
			OMP_GUI_TAILSCALE: bin,
			OMP_GUI_TEST_TAILSCALE_OPEN: openApp,
			FAKE_TAILSCALE_STATE: statePath,
			FAKE_TAILSCALE_LOG: logPath,
		},
		scenario: () => readTailscaleScenario(statePath),
		update: patch => writeTailscaleScenario(statePath, { ...readTailscaleScenario(statePath), ...patch }),
		invocations: () => readFakeInvocations(logPath),
	};
}
