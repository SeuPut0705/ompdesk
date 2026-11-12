import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type OmpLaunch, runSmol } from "./distill-model";

/**
 * `parseOmpJson`'s cases (the assistant's last message: text, model, tokens with the cache counted as input, the billed
 * cost; null without an assistant message) moved to Rust with the function: `upkeep/model.rs` replays 72 rows captured
 * from it, these two among them (`upkeep/model-captured.json`).
 *
 * `runSmol` is the core's request now, so these cases run it against the real core with a stand-in omp: a node script
 * behind the shim each platform starts (a `.cmd` on Windows, a shebang script elsewhere) that records what it was
 * started with and prints canned output.
 */

const end = (role: string, text: string, usage: Record<string, unknown>) =>
	JSON.stringify({
		type: "message_end",
		message: { role, model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage },
	});

const STAND_IN = `const fs = require("node:fs");
let input = "";
process.stdin
	.setEncoding("utf8")
	.on("data", chunk => {
		input += chunk;
	})
	.on("end", () => {
		fs.writeFileSync(
			process.env.STAND_IN_RECORD,
			JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, otel: process.env.OTEL_SDK_DISABLED ?? null }),
		);
		process.stdout.write(process.env.STAND_IN_STDOUT ?? "");
		process.stderr.write(process.env.STAND_IN_STDERR ?? "");
		process.exit(Number(process.env.STAND_IN_CODE ?? 0));
	});
`;

interface Canned {
	stdout?: string;
	stderr?: string;
	code?: number;
}

interface Recorded {
	args: string[];
	cwd: string;
	input: string;
	otel: string | null;
}

/** A stand-in omp in `root` that prints `canned`, and what it recorded once it ran. */
async function standIn(
	root: string,
	canned: Canned,
): Promise<{ launch: OmpLaunch; recorded: () => Promise<Recorded> }> {
	const script = join(root, "omp.js");
	const record = join(root, "record.json");
	await writeFile(script, STAND_IN);
	let bin: string;
	if (process.platform === "win32") {
		bin = join(root, "omp.cmd");
		await writeFile(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
	} else {
		bin = join(root, "omp");
		await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		await chmod(bin, 0o755);
	}
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	return {
		launch: {
			bin,
			env: {
				...env,
				// Another value than the one the call must set.
				OTEL_SDK_DISABLED: "false",
				STAND_IN_RECORD: record,
				STAND_IN_STDOUT: canned.stdout ?? "",
				STAND_IN_STDERR: canned.stderr ?? "",
				STAND_IN_CODE: String(canned.code ?? 0),
			},
		},
		recorded: async () => JSON.parse(await readFile(record, "utf8")) as Recorded,
	};
}

describe("runSmol", () => {
	it("asks the smol role with no tools, no session, no extensions, in an empty folder of its own, the digest on stdin", async () => {
		const root = await mkdtemp(join(tmpdir(), "upkeep-"));
		const cwd = join(root, "upkeep");
		try {
			const omp = await standIn(root, {
				stdout: end("assistant", "ok", { output: 1, cost: { total: 0.01 } }),
			});
			const result = await runSmol(omp.launch, { system: "SYSTEM", user: "USER" }, cwd);
			expect(result).toEqual({
				text: "ok",
				model: "claude-sonnet-5-5",
				inputTokens: 0,
				outputTokens: 1,
				costUsd: 0.01,
			});
			expect((await stat(cwd)).isDirectory()).toBe(true);
			const call = await omp.recorded();
			expect(call.args).toEqual(
				expect.arrayContaining([
					"-p",
					"--mode",
					"json",
					"--no-tools",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-title",
					"--model",
					"pi/smol",
					"--thinking",
					"off",
				]),
			);
			expect(
				call.args.slice(call.args.indexOf("--system-prompt"), call.args.indexOf("--system-prompt") + 2),
			).toEqual(["--system-prompt", "SYSTEM"]);
			expect(await realpath(call.cwd)).toBe(await realpath(cwd));
			expect(call.input).toBe("USER");
			expect(call.otel).toBe("true");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("throws with omp's own last line when it fails or answers nothing", async () => {
		const root = await mkdtemp(join(tmpdir(), "upkeep-"));
		try {
			const failing = await standIn(root, { code: 1, stderr: "warn\nNo API key for anthropic" });
			await expect(runSmol(failing.launch, { system: "s", user: "u" }, root)).rejects.toThrow(
				"omp exited 1: No API key for anthropic",
			);
			const silent = await standIn(root, {});
			await expect(runSmol(silent.launch, { system: "s", user: "u" }, root)).rejects.toThrow("omp exited 0");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
