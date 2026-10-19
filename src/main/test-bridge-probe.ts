import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";

/** The omp a stock-pinned test runs; such a test skips when it is not installed. */
export const INSTALLED_OMP = join(homedir(), ".bun", "bin", "omp");

/**
 * Runs `source` as a bridge extension (beside a copy of resources/gui-bridge, so `./settings` imports resolve) on
 * the installed omp in an empty private agent dir, and returns the JSON it prints to stderr as `<name>=…`.
 * `OPENAI_API_KEY` is the only credential unless `env` adds one: it gives the catalog models, nothing is prompted
 * and no user data is read.
 */
export function runBridgeProbe(
	source: string,
	name: string,
	env: Record<string, string> = {},
): Record<string, unknown> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-roles-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "model-roles-probe.ts");
		writeFileSync(extension, source);
		const spawnEnv: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			...env,
		};
		const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
		for (const key of [...credentials, "OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]) {
			if (!(key in env)) Reflect.deleteProperty(spawnEnv, key);
		}
		const result = spawnSync(
			INSTALLED_OMP,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ env: spawnEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith(name));
		expect(line, result.stderr.slice(-2500)).toMatch(new RegExp(`^${name}=`));
		return JSON.parse(line?.slice(name.length + 1) ?? "{}") as Record<string, unknown>;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}
