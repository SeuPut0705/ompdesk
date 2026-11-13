import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect } from "vitest";
import { ompPackageRoot } from "./omp-runtime";

/** Bun's launcher for the global omp (`omp.exe` on Windows); a stock-pinned test skips when it is not installed. */
export const INSTALLED_OMP = join(homedir(), ".bun", "bin", process.platform === "win32" ? "omp.exe" : "omp");

/**
 * What a test starts to run the installed omp: `spawn(OMP_COMMAND.file, [...OMP_COMMAND.args, ...omp's own args])`.
 * On Windows Bun's `omp.exe` is a launcher that runs `bun <package>/dist/cli.js` as its own child and relays its
 * stdio, so a signal to it (`child.kill`) ends only the launcher: omp then reads its stdin's end and stops gracefully
 * (a `session_exit` "normal" in the journal of a test that meant a crash) and keeps its folders open past the test's
 * cleanup. The product stops the whole tree (`taskkill /T`, sidecar.ts), so a test starts omp itself there.
 */
export const OMP_COMMAND: { file: string; args: readonly string[] } = (() => {
	const root = process.platform === "win32" ? ompPackageRoot(INSTALLED_OMP) : null;
	return root ? { file: "bun", args: [join(root, "dist", "cli.js")] } : { file: INSTALLED_OMP, args: [] };
})();

/**
 * `PI_CONFIG_DIR` naming `folder` for an omp whose home folder is `home`. Stock joins the value to the home folder
 * (pi-utils dirs.ts `getBaseConfigRoot`), so an absolute path fails on Windows (`C:\Users\x\C:\…`) and lands under
 * home on macOS. An empty value would mean stock's `.omp`, hence `.` for the home folder itself.
 */
export function configDirName(folder: string, home = homedir()): string {
	return relative(home, folder) || ".";
}

/**
 * Takes every AWS credential source out of `env`, an environment a test hands the installed omp as "no provider but
 * the fake key it adds". Stock counts Amazon Bedrock as signed in on any host that has one (pi-ai
 * `registry/aws.ts` `hasAwsCredentialSource`): `AWS_*` keys, the shared files under the home folder and, on an EC2
 * instance, its instance role, which it finds by the machine's DMI ids (`isEc2Host`). CI's runners are sometimes
 * hosted on AWS ("Cloud: AWS" in the job log), where a probe's smol role then resolved to `amazon-bedrock/…` and
 * `accounts.signedIn` read true (run 43366738799, attempt 1). `AWS_EC2_METADATA_DISABLED` is stock's own switch for
 * the instance role; the shared files are pointed into `folder`, where none exist.
 */
export function withoutAwsCredentials(env: Record<string, string | undefined>, folder: string): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("AWS_")) Reflect.deleteProperty(env, key);
	}
	env.AWS_EC2_METADATA_DISABLED = "true";
	env.AWS_SHARED_CREDENTIALS_FILE = join(folder, "no-aws-credentials");
	env.AWS_CONFIG_FILE = join(folder, "no-aws-config");
}

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
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			...env,
		};
		const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
		for (const key of [...credentials, "OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]) {
			if (!(key in env)) Reflect.deleteProperty(spawnEnv, key);
		}
		withoutAwsCredentials(spawnEnv, isolated);
		const result = spawnSync(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				extension,
			],
			{ env: spawnEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith(name));
		expect(line, result.stderr.slice(-2500)).toMatch(new RegExp(`^${name}=`));
		return JSON.parse(line?.slice(name.length + 1) ?? "{}") as Record<string, unknown>;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}
