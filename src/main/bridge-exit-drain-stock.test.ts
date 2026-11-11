import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Stock ends an RPC omp whose stdin closed with `process.exit(0)` right after it disposed the session
 * (rpc-mode.ts `disposeAndExit`), and the cleanup pass the `exit` event starts is not awaited. A login refresh in
 * flight is such a cleanup (`pi-ai` auth/refresh.ts registers its drain exit-only, with 125 s to save): the provider
 * has swapped the refresh token, the process ends before the save, and the account drops off the list at its next
 * refresh. That is how OMPdesk stops an omp on Windows, and everywhere when Memory is on (`stopOmp`).
 *
 * Installed omp, no account and no provider: a second extension registers a cleanup shaped as the refresh's (exit-only,
 * a deadline, a wait message) through the same `postmortem` the running omp uses, and leaves a file once it is done.
 */

const SAVE = `
import { writeFileSync } from "node:fs";
import { postmortem } from "@oh-my-pi/pi-utils";
export default function () {
	postmortem.register(
		"ompdesk-test-save",
		async () => {
			await Bun.sleep(700);
			writeFileSync(process.env.OMPDESK_TEST_SAVED, "saved");
		},
		{ exitOnly: true, deadlineMs: 20_000, waitMessage: "Waiting for the test save" },
	);
}
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

describe.skipIf(!existsSync(omp))("an omp whose stdin closes, on stock omp", () => {
	it("finishes a save its exit waits for, and says on stderr that it waits", async () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-exit-drain-"));
		chmodSync(isolated, 0o700);
		cleanups.push(() => rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
		const agentDir = join(isolated, "agent");
		mkdirSync(agentDir, { recursive: true });
		// omp does not start without a model; nothing is asked of this one.
		writeFileSync(
			join(agentDir, "models.yml"),
			"providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n",
		);
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-exit-drain-cwd-")));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
		const save = join(isolated, "save.ts");
		writeFileSync(save, SAVE);
		const saved = join(isolated, "saved");
		const address = newBridgeAddress();
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
			Reflect.deleteProperty(env, key);
		for (const key of Object.keys(env)) if (key.startsWith("OMP_GUI_")) Reflect.deleteProperty(env, key);
		env.OMP_GUI_BRIDGE = address;
		env.OMPDESK_TEST_SAVED = saved;
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				...["--mode", "rpc-ui", "--no-session", "--no-extensions", "--no-skills", "--no-rules"],
				...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts"), "-e", save],
			],
			{ cwd, env: env as NodeJS.ProcessEnv },
		);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		cleanups.push(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited.promise;
			removeBridgeAddress(address);
		});
		const ready = Promise.withResolvers<void>();
		createInterface({ input: child.stdout }).on("line", line => {
			if (line.includes('"type":"ready"')) ready.resolve();
		});
		void exited.promise.then(() => ready.reject(new Error(`omp ended before it was ready\n${stderr.slice(-2000)}`)));
		await ready.promise;

		// Main's connection is the bridge's first use: its areas load and install their hooks.
		const bridge = new GuiBridgeClient(address);
		await bridge.connect(30_000);
		await bridge.request("capabilities");
		bridge.close();

		child.stdin.end();
		await exited.promise;
		expect(stderr).toMatch(/Waiting for the test save \(up to \d+ s\)…/);
		expect(existsSync(saved)).toBe(true);
	}, 120_000);
});
