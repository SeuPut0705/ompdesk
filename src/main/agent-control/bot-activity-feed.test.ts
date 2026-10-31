import { describe, expect, it } from "vitest";
import { botVisited } from "../../shared/bot-activity";
import { BotActivityLog } from "./bot-activity";
import { botToolActivity } from "./bot-activity-feed";

describe("botToolActivity", () => {
	it("names what each kind of tool touched", () => {
		expect(botToolActivity("read", { path: "src/main/index.ts:1-20" })).toMatchObject({
			kind: "read",
			text: "read src/main/index.ts:1-20",
			target: { type: "file", value: "src/main/index.ts:1-20" },
		});
		expect(botToolActivity("read", { path: "https://example.com/docs" })?.target).toEqual({
			type: "url",
			value: "https://example.com/docs",
		});
		expect(botToolActivity("web_search", { query: "omp release notes" })).toMatchObject({
			kind: "read",
			target: { type: "query", value: "omp release notes" },
		});
		expect(botToolActivity("bash", { command: "git log --oneline -3\necho done" })).toMatchObject({
			kind: "run",
			text: "bash git log --oneline -3",
		});
		expect(botToolActivity("edit", { input: "[src/a.ts#1A2B]\nPUT 1:\n+x\n[src/b.ts#3C4D]\nCUT 2" })).toMatchObject({
			kind: "change",
			text: "edit src/a.ts, src/b.ts",
			target: { type: "file", value: "src/a.ts" },
		});
		expect(botToolActivity("ompdesk_session_open", { message: "Fix the build" })).toMatchObject({
			kind: "sessions",
		});
		expect(botToolActivity("ompdesk_session_answer", { session: "abc", choice: "Allow" })).toMatchObject({
			kind: "approval",
			target: { type: "session", value: "abc" },
		});
		expect(botToolActivity("generate_image", {})).toMatchObject({ kind: "tool", text: "generate_image" });
	});

	it("leaves out the calls whose effect the log hears elsewhere", () => {
		for (const tool of ["ompdesk_bot", "ompdesk_notify", "todo"]) expect(botToolActivity(tool, {})).toBeNull();
	});

	it("feeds what the bot read into the visited list", () => {
		const log = new BotActivityLog({ file: null });
		for (const [tool, args] of [
			["read", { path: "/a.ts" }],
			["bash", { command: "ls" }],
			["web_search", { query: "q" }],
		] as const) {
			const draft = botToolActivity(tool, args);
			if (draft) log.append(draft);
		}
		expect(botVisited(log.entries()).map(entry => entry.target?.value)).toEqual(["q", "/a.ts"]);
	});
});
