/**
 * A failed SSH test against the user's real omp (skipped without one, and on
 * Windows where the fake client below is a shell script): the bridge's
 * `ssh_test` reports stock's error and adds OpenSSH's own `-v` trace of one
 * fresh attempt, run without the shared ControlMaster.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcSshTestResult } from "../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

describe.skipIf(process.platform === "win32" || !existsSync(omp) || !existsSync(stockRoot))(
	"ssh diagnostics bridge",
	() => {
		it("adds the verbose trace of a fresh attempt to a failed test", async () => {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-diag-"));
			const agent = path.join(profile, "agent");
			const bin = path.join(profile, "bin");
			await fs.mkdir(agent, { mode: 0o700 });
			await fs.mkdir(bin);
			// A client that refuses every login and says how it was called.
			await fs.writeFile(
				path.join(bin, "ssh"),
				'#!/bin/sh\necho "debug1: fake client args: $*" >&2\necho "Permission denied (publickey)." >&2\nexit 255\n',
				{ mode: 0o755 },
			);
			await fs.writeFile(
				path.join(agent, "models.yml"),
				"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
			);
			const address = newBridgeAddress();
			const env = {
				...process.env,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				HOME: profile,
				USERPROFILE: profile,
				PI_CODING_AGENT_DIR: agent,
				PI_CONFIG_DIR: profile,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_GUI_BRIDGE: address,
			};
			const child = spawn(
				omp,
				[
					"--mode",
					"rpc-ui",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--model",
					"fixture/idle",
					"-e",
					path.resolve("resources/gui-bridge/index.ts"),
				],
				{ cwd: profile, env, stdio: "pipe" },
			);
			const client = new GuiBridgeClient(address);
			let errors = "";
			child.stderr.on("data", chunk => {
				errors += String(chunk);
			});
			try {
				const ready = Promise.withResolvers<void>();
				// Real child readiness is event-driven; this deadline only diagnoses a stuck external omp.
				const timer = setTimeout(() => ready.reject(new Error(`omp did not become ready: ${errors}`)), 40_000);
				child.once("error", ready.reject);
				child.once("exit", code => ready.reject(new Error(`omp exited ${code}: ${errors}`)));
				let output = "";
				child.stdout.on("data", chunk => {
					output += String(chunk);
					if (/"type"\s*:\s*"ready"/.test(output)) ready.resolve();
				});
				await ready.promise.finally(() => clearTimeout(timer));
				await client.connect();

				const result = await client.request<RpcSshTestResult>("ssh_test", {
					host: { name: "diag", host: "build.example.com", username: "deploy", port: 2222 },
				});
				expect(result).toMatchObject({ name: "diag", ok: false });
				expect(result.error).toMatch(/Permission denied/);
				expect(result.log).toContain("debug1: fake client args: -v -n");
				expect(result.log).toContain("ControlPath=none");
				expect(result.log).toContain("-p 2222 deploy@build.example.com exit");
				expect(result.log).toMatch(/\(exit 255\)$/);
			} finally {
				client.close();
				child.stdin.end();
				child.kill();
				if (child.exitCode === null && child.signalCode === null) {
					const exited = Promise.withResolvers<void>();
					child.once("exit", () => exited.resolve());
					await exited.promise;
				}
				removeBridgeAddress(address);
				await fs.rm(profile, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
