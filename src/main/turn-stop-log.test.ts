import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcCommand } from "../shared/rpc-types";
import { dispatchedCommand, recordTurnStop, setTurnStopLog } from "./turn-stop-log";

let lines: Array<Record<string, string | number>>;

beforeEach(() => {
	lines = [];
	setTurnStopLog({
		write: details => lines.push(details),
		sessionOf: tab => (tab === "t1" ? "/Users/me/.omp/agent/sessions/-p/2026_one.jsonl" : undefined),
	});
});

afterEach(() => setTurnStopLog(null));

describe("dispatchedCommand", () => {
	it("logs a window's Stop with its control and window, and takes the origin off before omp", () => {
		const command: RpcCommand = { type: "abort_and_restore_queue", origin: { surface: "esc" } };
		expect(dispatchedCommand(command, { tab: "t1", window: 3, channel: "rpc:command-for-tab" })).toEqual({
			type: "abort_and_restore_queue",
		});
		expect(lines).toEqual([
			{
				command: "abort_and_restore_queue",
				tab: "t1",
				by: "window",
				surface: "esc",
				window: 3,
				session: "2026_one.jsonl",
			},
		]);
	});

	it("names a paired web device, an agent tool's caller, and the channel when nothing said who", () => {
		dispatchedCommand(
			{ type: "abort", origin: { surface: "stop-button" } },
			{ tab: "t1", window: -2, webDevice: "phone-1" },
		);
		dispatchedCommand({ type: "abort", origin: { agentControl: "boss" } }, { tab: "t1", window: 1 });
		dispatchedCommand({ type: "abort" }, { tab: "t2", window: 1, channel: "rpc:command" });
		expect(lines).toEqual([
			{
				command: "abort",
				tab: "t1",
				by: "web-device",
				surface: "stop-button",
				window: -2,
				device: "phone-1",
				session: "2026_one.jsonl",
			},
			{ command: "abort", tab: "t1", by: "agent-control", window: 1, caller: "boss", session: "2026_one.jsonl" },
			{ command: "abort", tab: "t2", by: "window", window: 1, channel: "rpc:command" },
		]);
	});

	it("never logs the text of an abort_and_prompt, and leaves other commands alone", () => {
		dispatchedCommand(
			{ type: "abort_and_prompt", message: "secret plan", origin: { surface: "retry" } },
			{ tab: "t1", window: 1 },
		);
		const prompt: RpcCommand = { type: "prompt", message: "hi" };
		expect(dispatchedCommand(prompt, { tab: "t1", window: 1 })).toBe(prompt);
		expect(lines).toHaveLength(1);
		expect(JSON.stringify(lines)).not.toContain("secret plan");
	});

	it("keeps the origin on a command bound for a paired host, which logs it again, and names the host", () => {
		const command: RpcCommand = { type: "abort", origin: { surface: "send-menu" } };
		expect(dispatchedCommand(command, { tab: "t1", window: 4, host: "mac-mini" })).toBe(command);
		expect(lines[0]).toMatchObject({ by: "window", surface: "send-menu", host: "mac-mini" });
	});
});

it("logs a Stop main sends itself with what it knows", () => {
	recordTurnStop({ command: "abort", tab: "t1", by: "quit" });
	expect(lines).toEqual([{ command: "abort", tab: "t1", by: "quit", session: "2026_one.jsonl" }]);
});
