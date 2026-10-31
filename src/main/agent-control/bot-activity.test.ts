import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_ACTIVITY_KEPT, BOT_ACTIVITY_PAGE, botVisited } from "../../shared/bot-activity";
import { BOT_CHANNELS_MAX } from "../../shared/bot-desk";
import { BotActivityLog } from "./bot-activity";
import { BotDesk } from "./bot-desk";
import { editBotDesk } from "./bot-desk-edit";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "bot-activity-"));
	file = path.join(dir, "bot-activity.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("BotActivityLog", () => {
	it("keeps the newest entries across a restart, skipping a damaged one, and pages the newest", () => {
		const log = new BotActivityLog({ file });
		for (let index = 0; index < BOT_ACTIVITY_KEPT + 5; index++)
			log.append({ kind: "run", action: "tool", by: "bot", text: `bash echo ${index}`, tool: "bash" });
		log.flush();
		const stored = JSON.parse(readFileSync(file, "utf8"));
		expect(stored).toHaveLength(BOT_ACTIVITY_KEPT);
		expect(stored[0].text).toBe("bash echo 5");
		writeFileSync(file, JSON.stringify([{ id: "x" }, ...stored.slice(-2)]));
		const reloaded = new BotActivityLog({ file });
		expect(reloaded.entries().map(entry => entry.text)).toEqual([
			`bash echo ${BOT_ACTIVITY_KEPT + 3}`,
			`bash echo ${BOT_ACTIVITY_KEPT + 4}`,
		]);
		expect(log.page().entries).toHaveLength(BOT_ACTIVITY_PAGE);
		expect(log.page().entries.at(-1)?.text).toBe(`bash echo ${BOT_ACTIVITY_KEPT + 4}`);
	});

	it("writes a burst of appends once, a moment later", () => {
		vi.useFakeTimers();
		try {
			const log = new BotActivityLog({ file });
			log.append({ kind: "read", action: "tool", by: "bot", text: "read a" });
			log.append({ kind: "read", action: "tool", by: "bot", text: "read b" });
			expect(() => readFileSync(file, "utf8")).toThrow();
			vi.advanceTimersByTime(600);
			expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lists each file and page the bot read once, newest first", () => {
		const log = new BotActivityLog({ file: null });
		const read = (type: "file" | "url", value: string) =>
			log.append({ kind: "read", action: "tool", by: "bot", text: value, target: { type, value } });
		read("file", "/a.ts");
		read("url", "https://example.com");
		log.append({ kind: "run", action: "tool", by: "bot", text: "bash ls" });
		read("file", "/a.ts");
		expect(botVisited(log.entries()).map(entry => entry.target?.value)).toEqual(["/a.ts", "https://example.com"]);
	});
});

describe("editBotDesk", () => {
	function rig() {
		const activity = new BotActivityLog({ file: null });
		const desk = new BotDesk({ file: null, activity: draft => void activity.append(draft) });
		const created: string[] = [];
		const deleted: string[] = [];
		const deps = {
			desk,
			activity,
			createSideChat: async (topic: string) => {
				created.push(topic);
				return `/s/${created.length}.jsonl`;
			},
			deleteSession: async (sessionPath: string) => void deleted.push(sessionPath),
		};
		return { activity, desk, deps, created, deleted };
	}

	it("undoes a change once, and refuses what cannot be undone", async () => {
		const { activity, desk, deps } = rig();
		const memory = desk.remember("Ships on Fridays", "bot").memory;
		desk.forget(memory.id, "owner");
		const forgot = activity.entries().find(entry => entry.action === "memory_forget");
		await editBotDesk(deps, { op: "undo", activity: forgot?.id ?? "" }, "owner");
		expect(desk.state().memories).toEqual([memory]);
		await expect(editBotDesk(deps, { op: "undo", activity: forgot?.id ?? "" }, "owner")).rejects.toThrow(
			/already undone/,
		);
		desk.postDecision({ question: "Ship?" });
		const posted = activity.entries().find(entry => entry.action === "decision_post");
		await expect(editBotDesk(deps, { op: "undo", activity: posted?.id ?? "" }, "owner")).rejects.toThrow(
			/cannot be undone/,
		);
		await expect(editBotDesk(deps, { op: "undo", activity: "gone" }, "owner")).rejects.toThrow(/no longer/);
	});

	it("makes a side chat's session before recording it, deletes it before forgetting it, and makes none past the cap", async () => {
		const { desk, deps, created, deleted } = rig();
		await editBotDesk(deps, { op: "channel_add", title: "Release notes" }, "owner");
		const [channel] = desk.state().channels;
		expect(channel).toMatchObject({ title: "Release notes", sessionPath: "/s/1.jsonl" });
		await editBotDesk(deps, { op: "channel_remove", id: channel?.id ?? "" }, "owner");
		expect(deleted).toEqual(["/s/1.jsonl"]);
		expect(desk.state().channels).toEqual([]);

		for (let index = 0; index < BOT_CHANNELS_MAX; index++)
			await editBotDesk(deps, { op: "channel_add", title: `topic ${index}` }, "owner");
		await expect(editBotDesk(deps, { op: "channel_add", title: "one more" }, "owner")).rejects.toThrow(/at most/);
		expect(created).toHaveLength(BOT_CHANNELS_MAX + 1);
	});
});
