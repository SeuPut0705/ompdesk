/**
 * Model setup research run: stock `omp --mode rpc` with research tools only,
 * the prompt over the open stdin pipe, progress and the final reply read from
 * the stock event stream, and stdin closed (omp exits) once the run ends.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelSetupRequest } from "../shared/model-setup";
import { ModelSetupRunner, modelSetupArgs, modelSetupInput, ResearchStream } from "./model-setup-runner";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

const REQUEST: ModelSetupRequest = {
	researchModel: "anthropic/claude-opus-4-1",
	models: [
		{ selector: "anthropic/claude-opus-4-1", provider: "anthropic" },
		{ selector: "openai/gpt-5.2", provider: "openai" },
	],
	roles: [
		{ id: "default", name: "Default" },
		{ id: "advisor", name: "Advisor" },
	],
};

const PLAN = {
	assignments: [{ role: "advisor", model: "openai/gpt-5.2", reason: "Other vendor." }],
	advisor: { enable: true, reason: "Worth it." },
	sources: [{ title: "Board", url: "https://example.com" }],
};

/** Stock frames as RPC mode prints them (rpc-session-events.ts stamps, rpc-types.ts prompt_result). */
const line = (frame: object) => JSON.stringify(frame);
const assistant = (text: string, extra: object = {}) =>
	line({
		type: "message_end",
		messageId: "msg-2",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text },
			],
			stopReason: "stop",
			...extra,
		},
	});

describe("research event stream", () => {
	it("keeps the latest tool call and the last assistant reply until prompt_result", () => {
		const stream = new ResearchStream();
		stream.push(line({ type: "response", id: "events", command: "set_event_filter", success: true }));
		stream.push(line({ type: "response", id: "model-setup", command: "prompt", success: true }));
		stream.push(
			line({ type: "tool_execution_start", toolCallId: "1", toolName: "web_search", args: { query: "swe-bench" } }),
		);
		expect(stream.activity).toEqual({ tool: "web_search", detail: "swe-bench" });
		stream.push(assistant("Let me read the leaderboard."));
		stream.push(
			line({
				type: "message_end",
				message: { role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "{}" }] },
			}),
		);
		stream.push(
			line({
				type: "tool_execution_start",
				toolCallId: "2",
				toolName: "read",
				args: { path: "https://example.com" },
				intent: "Reading the leaderboard",
			}),
		);
		expect(stream.activity).toEqual({ tool: "read", detail: "Reading the leaderboard" });
		stream.push("not json");
		stream.push(assistant(JSON.stringify(PLAN)));
		expect(stream.outcome).toBeUndefined();
		stream.push(line({ type: "prompt_result", id: "other", status: "completed" }));
		expect(stream.outcome).toBeUndefined();
		stream.push(
			line({
				type: "prompt_result",
				id: "model-setup",
				agentInvoked: true,
				status: "completed",
				sessionSettled: true,
			}),
		);
		expect(stream.outcome).toEqual({ ok: true, text: JSON.stringify(PLAN) });
	});

	it("reports the provider error, a refused prompt, and an empty reply", () => {
		const failed = new ResearchStream();
		failed.push(assistant("", { stopReason: "error", errorMessage: "429 rate limited" }));
		failed.push(line({ type: "prompt_result", id: "model-setup", status: "completed" }));
		expect(failed.outcome).toEqual({ ok: false, error: "429 rate limited" });

		const errored = new ResearchStream();
		errored.push(
			line({
				type: "prompt_result",
				id: "model-setup",
				status: "error",
				error: { message: "No API key", retryable: false },
			}),
		);
		expect(errored.outcome).toEqual({ ok: false, error: "No API key" });

		const refused = new ResearchStream();
		refused.push(line({ type: "response", id: "model-setup", command: "prompt", success: false, error: "busy" }));
		expect(refused.outcome).toEqual({ ok: false, error: "busy" });

		const empty = new ResearchStream();
		empty.push(line({ type: "prompt_result", id: "model-setup", status: "completed" }));
		expect(empty.outcome).toEqual({ ok: false, error: "The research model returned no reply" });
	});
});

describe("research invocation", () => {
	it("runs stock RPC mode with research tools only and sends the prompt on stdin", () => {
		expect(modelSetupArgs("openai/gpt-5.2")).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"openai/gpt-5.2",
			"--thinking",
			"auto",
			"--tools",
			"web_search,read",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-title",
		]);
		const frames = modelSetupInput(REQUEST)
			.trim()
			.split("\n")
			.map(entry => JSON.parse(entry));
		expect(frames[0]).toEqual({
			id: "events",
			type: "set_event_filter",
			events: ["tool_execution_start", "message_end"],
			messageUpdates: "delta",
		});
		expect(frames[1]).toMatchObject({ id: "model-setup", type: "prompt" });
		expect(frames[1].message).toContain("openai/gpt-5.2");
	});
});

/** A fake omp speaking stock RPC: logs argv and stdin, answers, and notes when stdin closes. */
function rpcFake(dir: string, research: string): string {
	return [
		'import * as fs from "node:fs";',
		'import { createInterface } from "node:readline";',
		`const dir = ${JSON.stringify(dir)};`,
		"fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));",
		"const out = (frame: object) => process.stdout.write(JSON.stringify(frame) + '\\n');",
		"const rl = createInterface({ input: process.stdin });",
		"rl.on('line', line => {",
		"\tfs.appendFileSync(dir + '/stdin.jsonl', line + '\\n');",
		"\tconst command = JSON.parse(line);",
		"\tout({ type: 'response', id: command.id, command: command.type, success: true });",
		`\tif (command.type === "prompt") { ${research} }`,
		"});",
		"rl.on('close', () => { fs.writeFileSync(dir + '/closed', ''); process.exit(0); });",
	].join("\n");
}

const exists = (file: string) =>
	fs.stat(file).then(
		() => true,
		() => false,
	);

// Every case here but one spawns a fake omp (a bun script, behind a cmd.exe shim on
// Windows). A cold spawn on a loaded CI runner alone can take seconds, so the
// default 5s per-test budget failed at random; each wait inside stays bounded by its signal.
describe("ModelSetupRunner", { timeout: 30_000 }, () => {
	it("returns the parsed plan, shows progress meanwhile, and closes omp's stdin", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-setup-"));
		try {
			const reply = {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Plan:\n${JSON.stringify(PLAN)}` }],
					stopReason: "stop",
				},
			};
			const bin = await writeFakeOmp(
				dir,
				rpcFake(
					dir,
					[
						"out({ type: 'tool_execution_start', toolCallId: '1', toolName: 'web_search', args: { query: 'benchmarks' } });",
						// The reply waits for the test's `go` file, so the run is observably in progress until then.
						"const watcher = fs.watch(dir, () => { if (!fs.existsSync(dir + '/go')) return; watcher.close();",
						`out(${JSON.stringify(reply)});`,
						"out({ type: 'prompt_result', id: command.id, status: 'completed' }); });",
					].join(" "),
				),
			);
			const runner = new ModelSetupRunner();
			const result = runner.run(bin, REQUEST, process.env);
			await expect
				.poll(() => runner.status().activity, { timeout: 15_000 })
				.toEqual({
					tool: "web_search",
					detail: "benchmarks",
				});
			expect(runner.status()).toMatchObject({ running: true, startedAt: expect.any(Number) });
			await expect(runner.run(bin, REQUEST, process.env)).resolves.toMatchObject({
				success: false,
				code: "model_setup_running",
			});
			await fs.writeFile(path.join(dir, "go"), "");
			await expect(result).resolves.toEqual({ success: true, plan: PLAN, dropped: [] });
			expect(runner.status()).toEqual({ running: false });
			await expect.poll(() => exists(path.join(dir, "closed")), { timeout: 15_000 }).toBe(true);
			expect(JSON.parse(await fs.readFile(path.join(dir, "argv.json"), "utf8"))).toEqual(
				modelSetupArgs("anthropic/claude-opus-4-1"),
			);
			const stdin = (await fs.readFile(path.join(dir, "stdin.jsonl"), "utf8")).trim().split("\n");
			expect(stdin.map(entry => JSON.parse(entry).type)).toEqual(["set_event_filter", "prompt"]);
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("cancels a run that never finishes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-setup-"));
		try {
			const bin = await writeFakeOmp(dir, rpcFake(dir, ""));
			const runner = new ModelSetupRunner();
			const result = runner.run(bin, REQUEST, process.env);
			await expect.poll(() => exists(path.join(dir, "stdin.jsonl")), { timeout: 15_000 }).toBe(true);
			expect(runner.abort()).toBe(true);
			await expect(result).resolves.toMatchObject({ success: false, cancelled: true });
			expect(runner.running).toBe(false);
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("refuses an invalid request without spawning", async () => {
		const runner = new ModelSetupRunner();
		await expect(runner.run("/nonexistent/omp", { ...REQUEST, models: [] }, process.env)).resolves.toMatchObject({
			success: false,
			code: "model_setup_invalid",
		});
	});

	it("reports a reply without a usable plan with the reply text", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-setup-"));
		try {
			const bin = await writeFakeOmp(
				dir,
				rpcFake(
					dir,
					`out(${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I could not find benchmarks." }], stopReason: "stop" } })}); out({ type: 'prompt_result', id: command.id, status: 'completed' });`,
				),
			);
			await expect(new ModelSetupRunner().run(bin, REQUEST, process.env)).resolves.toMatchObject({
				success: false,
				code: "model_setup_no_plan",
				reply: "I could not find benchmarks.",
			});
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});
});
