import { describe, expect, it } from "vitest";
import { AGENT_CONTROL_TOOLS } from "../../../../shared/agent-control";
import type { ToolEntry } from "../../../stores/tools";
import { coordinationWords, isCoordination } from "./coordination";

/** A translator that shows which key and figures the card asked for. */
const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ""}`;

function call(toolName: string, args: Record<string, unknown>): ToolEntry {
	return {
		toolName,
		args,
		status: "running",
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: 0,
		endTime: null,
	};
}

/** Stock's `xd://` device write: the tool's arguments travel as a JSON string. */
function device(tool: string, args: unknown): ToolEntry {
	return call("write", { path: `xd://${tool}`, content: typeof args === "string" ? args : JSON.stringify(args) });
}

const result = (args: unknown) => device(AGENT_CONTROL_TOOLS.result, args);
const titles: Record<string, string> = { "child-1": "Skill packs", "child-2": "Sidebar folds" };
const titleOf = (id: string) => titles[id];

describe("coordination words", () => {
	it("says a wait for one of several sessions in words, called as a device write or directly", () => {
		const args = { sessions: ["child-1", "child-2"], wait: true, until: "any" };
		expect(coordinationWords(result(args), t)).toBe('chat.work.waits.any{"count":2}');
		expect(coordinationWords(call(AGENT_CONTROL_TOOLS.result, args), t)).toBe('chat.work.waits.any{"count":2}');
	});

	it("says a wait for all of them", () => {
		expect(coordinationWords(result({ sessions: ["a", "b", "c"], wait: true, until: "all" }), t)).toBe(
			'chat.work.waits.all{"count":3}',
		);
	});

	it("counts the sessions when the wait names no condition", () => {
		expect(coordinationWords(result({ sessions: ["a", "b"], wait: true }), t)).toBe(
			'chat.work.waits.sessions{"count":2}',
		);
	});

	it("names a single session by the title of its row, never by its id", () => {
		expect(coordinationWords(result({ sessions: ["child-1"], wait: true }), t, titleOf)).toBe(
			'chat.work.waits.one{"name":"Skill packs"}',
		);
		expect(coordinationWords(result({ session: "child-2", wait: true }), t, titleOf)).toBe(
			'chat.work.waits.one{"name":"Sidebar folds"}',
		);
		// No row for the id (a session on another device, one already gone): generic words, not the id.
		for (const words of [
			coordinationWords(result({ sessions: ["unknown9"], wait: true }), t, titleOf),
			coordinationWords(result({ session: "unknown9", wait: true }), t),
		]) {
			expect(words).toBe("chat.work.waits.generic");
			expect(words).not.toContain("unknown9");
		}
	});

	it("never puts an id in the words of a wait for several, resolved or not", () => {
		const words = coordinationWords(
			result({ sessions: ["child-1", "zzz-id"], wait: true, until: "all" }),
			t,
			titleOf,
		);
		expect(words).toBe('chat.work.waits.all{"count":2}');
		expect(words).not.toContain("zzz-id");
	});

	it("falls back to generic words when the arguments are unknown, never to the raw arguments", () => {
		for (const bad of ["not json {", "[1,2]", ""]) {
			expect(coordinationWords(result(bad), t)).toBe("chat.work.coordinating");
		}
		for (const noNames of [{ sessions: [], wait: true }, { sessions: [null, 3], wait: true }, { wait: true }]) {
			expect(coordinationWords(result(noNames), t)).toBe("chat.work.waits.generic");
		}
		expect(coordinationWords(result("not json {"), t)).not.toContain("not json");
	});

	it("words a result read that does not wait, and every other session tool, as working with the sessions", () => {
		expect(coordinationWords(result({ sessions: ["a"], wait: false }), t)).toBe("chat.work.coordinating");
		const open = device(AGENT_CONTROL_TOOLS.open, { prompt: "do the thing" });
		expect(coordinationWords(open, t)).toBe("chat.work.coordinating");
		expect(coordinationWords(open, t)).not.toContain("do the thing");
		expect(coordinationWords(call(AGENT_CONTROL_TOOLS.list, { scope: "app" }), t)).toBe("chat.work.coordinating");
	});

	it("is silent for any call that is no session tool, and leaves the other ompdesk tools their stage", () => {
		expect(coordinationWords(call("bash", { command: "ls" }), t)).toBe("");
		expect(coordinationWords(call("write", { path: "src/a.ts", content: "x" }), t)).toBe("");
		expect(coordinationWords(call("write", { path: "xd://other_tool", content: "{}" }), t)).toBe("");
		expect(coordinationWords(undefined, t)).toBe("");
		expect(isCoordination(result({}))).toBe(true);
		expect(isCoordination(call("bash", { command: "ls" }))).toBe(false);
		for (const tool of ["app", "notify", "schedule", "autopilot", "report", "compare", "merge", "appList"] as const) {
			const name = AGENT_CONTROL_TOOLS[tool];
			expect(isCoordination(call(name, {})), name).toBe(false);
			expect(isCoordination(device(name, {})), `xd://${name}`).toBe(false);
			expect(coordinationWords(call(name, {}), t), name).toBe("");
		}
		for (const tool of ["list", "open", "send", "result", "read", "answer", "focus", "stop"] as const) {
			expect(isCoordination(call(AGENT_CONTROL_TOOLS[tool], {})), tool).toBe(true);
		}
	});
});
