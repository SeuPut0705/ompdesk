import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/shared/rpc-types";
import { type RecordedWorkFrame, rebaseWorkRecording, scrubWorkRecording } from "./work-recording";

const delta = (text: string, atMs: number): RecordedWorkFrame => {
	const message: AgentMessage = { role: "assistant", timestamp: 1, content: [] };
	return {
		channel: "main",
		atMs,
		events: [
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: text, partial: message },
			},
		],
	};
};
function deltas(recording: readonly RecordedWorkFrame[]): string {
	return recording
		.flatMap(frame =>
			frame.channel === "main"
				? frame.events.flatMap(event =>
						event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta"
							? [event.assistantMessageEvent.delta]
							: [],
					)
				: [],
		)
		.join("");
}
describe("actual work recording", () => {
	it("scrubs private paths split across tool-call deltas without changing order or commands", () => {
		const source = [delta('{"cwd":"/private/', 80), delta('agent-root/project","command":"wc -l alpha.txt"}', 160)];
		const scrubbed = scrubWorkRecording(source, "/private/agent-root");
		expect(scrubbed.map(frame => frame.atMs)).toEqual([10, 20]);
		expect(JSON.parse(deltas(scrubbed))).toEqual({
			cwd: "/tmp/ompdesk-real-replay/project",
			command: "wc -l alpha.txt",
		});
		expect(deltas(source)).toContain("/private/agent-root");
	});
	it("keeps stock compound call IDs and interruption details", () => {
		const source: RecordedWorkFrame[] = [
			{
				channel: "main",
				atMs: 80,
				events: [
					{
						type: "tool_execution_end",
						toolCallId: "call_alpha|fc_alpha",
						toolName: "wait",
						isError: true,
						result: {
							content: [],
							details: { __interrupted: true, source: "interrupt_skipped", execution: "started" },
						},
					},
				],
			},
		];
		expect(scrubWorkRecording(source, "/private/agent-root")[0]).toEqual({ ...source[0], atMs: 10 });
	});
	it("rebases old transcript clocks without changing measured command durations", () => {
		const source: RecordedWorkFrame[] = [
			delta("command", 80),
			{
				channel: "main",
				atMs: 160,
				events: [
					{
						type: "message_end",
						message: {
							role: "toolResult",
							toolCallId: "bash|fc",
							toolName: "bash",
							content: [],
							isError: false,
							timestamp: 81,
							details: { wallTimeMs: 3000, durationMs: 12000 },
						},
					},
				],
			},
		];
		const replay = rebaseWorkRecording(source, 1000);
		expect(replay[0]).toMatchObject({ atMs: 80, events: [{ message: { timestamp: 1000 } }] });
		expect(replay[1]).toMatchObject({
			atMs: 160,
			events: [{ message: { timestamp: 1010, details: { wallTimeMs: 3000, durationMs: 12000 } } }],
		});
	});
});
