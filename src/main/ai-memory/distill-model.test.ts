import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOmpJson, runSmol } from "./distill-model";

const end = (role: string, text: string, usage: Record<string, unknown>) =>
	JSON.stringify({
		type: "message_end",
		message: { role, model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage },
	});

describe("parseOmpJson", () => {
	it("reads the assistant's last message: text, model, tokens (cache counted as input) and the billed cost", () => {
		const stdout = [
			JSON.stringify({ type: "message_start" }),
			end("user", "ignored", {}),
			end("assistant", '{"pages":[]}', {
				input: 4,
				output: 186,
				cacheRead: 565,
				cacheWrite: 3164,
				cost: { total: 0.0145805 },
			}),
			"not json",
		].join("\n");
		expect(parseOmpJson(stdout)).toEqual({
			text: '{"pages":[]}',
			model: "claude-sonnet-5-5",
			inputTokens: 3733,
			outputTokens: 186,
			costUsd: 0.0145805,
		});
	});

	it("is null when the run produced no assistant message", () => {
		expect(parseOmpJson("")).toBeNull();
		expect(parseOmpJson(end("user", "x", {}))).toBeNull();
	});
});

describe("runSmol", () => {
	it("asks the smol role with no tools, no session, no extensions, in an empty folder of its own, the digest on stdin", async () => {
		const root = await mkdtemp(join(tmpdir(), "upkeep-"));
		const cwd = join(root, "upkeep");
		const calls: { args: string[]; cwd?: string; input?: string; env?: Record<string, string> }[] = [];
		try {
			const result = await runSmol(
				{
					run: async (args, opts) => {
						calls.push({ args, ...opts });
						return { code: 0, stdout: end("assistant", "ok", { output: 1, cost: { total: 0.01 } }), stderr: "" };
					},
				},
				{ system: "SYSTEM", user: "USER" },
				cwd,
			);
			expect(result.text).toBe("ok");
			expect((await stat(cwd)).isDirectory()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		const [call] = calls;
		expect(call?.args).toEqual(
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
		expect(call?.args.slice(call.args.indexOf("--system-prompt"), call.args.indexOf("--system-prompt") + 2)).toEqual([
			"--system-prompt",
			"SYSTEM",
		]);
		expect(call).toMatchObject({ cwd, input: "USER", env: { OTEL_SDK_DISABLED: "true" } });
	});

	it("throws with omp's own last line when it fails or answers nothing", async () => {
		const failing = { run: async () => ({ code: 1, stdout: "", stderr: "warn\nNo API key for anthropic" }) };
		const dir = await mkdtemp(join(tmpdir(), "upkeep-"));
		try {
			await expect(runSmol(failing, { system: "s", user: "u" }, dir)).rejects.toThrow(
				"omp exited 1: No API key for anthropic",
			);
			await expect(
				runSmol({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }, { system: "s", user: "u" }, dir),
			).rejects.toThrow("omp exited 0");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
