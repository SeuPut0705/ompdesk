import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotActivityDraft } from "../../shared/bot-activity";
import {
	BOT_DECISIONS_ANSWERED_KEPT,
	BOT_DUTIES_MAX,
	BOT_MEMORIES_MAX,
	BotDeskFileSchema,
	EMPTY_BOT_DESK,
	EMPTY_BOT_DESK_FILE,
	openBotDecisions,
} from "../../shared/bot-desk";
import type { Schedule } from "../../shared/schedules";
import { BotDesk, BotDeskError, botDeskText, botWakes, isDeskChange } from "./bot-desk";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "bot-desk-"));
	file = path.join(dir, "bot-desk.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deskOver(target: string | null = file): BotDesk {
	let tick = 0;
	let counter = 0;
	return new BotDesk({
		file: target,
		now: () => new Date(Date.UTC(2026, 9, 31, 9, 0, tick++)),
		newId: () => (counter++).toString(16).padStart(8, "0"),
	});
}

describe("BotDesk", () => {
	it("keeps duties and decisions across a restart", () => {
		const desk = deskOver();
		desk.addDuty("  Check the nightly build every morning  ");
		const open = desk.postDecision({
			question: " Ship it? ",
			options: ["Yes", "No", "Yes"],
			context: "  CI is green ",
		});
		desk.postDecision({ question: "Which branch?" });
		desk.answer(open.id, "Yes");
		const reloaded = new BotDesk({ file }).state();
		expect(reloaded).toEqual(desk.state());
		expect(reloaded.duties.map(duty => duty.text)).toEqual(["Check the nightly build every morning"]);
		expect(reloaded.decisions[0]).toMatchObject({
			state: "answered",
			question: "Ship it?",
			options: ["Yes", "No"],
			context: "CI is green",
			answer: "Yes",
		});
		expect(openBotDecisions(reloaded).map(decision => decision.question)).toEqual(["Which branch?"]);
	});

	it("keeps the bot paused across a restart, and says nothing when it already is so", () => {
		const desk = deskOver();
		desk.addDuty("Watch the release");
		expect(desk.state()).not.toHaveProperty("paused");
		const heard = vi.fn();
		desk.onChange(heard);
		desk.setPaused(false);
		expect(heard).not.toHaveBeenCalled();
		desk.setPaused(true);
		expect(heard).toHaveBeenCalledTimes(1);
		expect(desk.state().paused).toBe(true);
		const written = readFileSync(file, "utf8");
		desk.setPaused(true);
		expect(heard).toHaveBeenCalledTimes(1);
		expect(readFileSync(file, "utf8")).toBe(written);
		const reloaded = new BotDesk({ file });
		expect(reloaded.state()).toEqual(desk.state());
		expect(reloaded.state().paused).toBe(true);
		reloaded.addDuty("Another");
		expect(reloaded.state().paused).toBe(true);
		reloaded.setPaused(false);
		expect(new BotDesk({ file }).state()).not.toHaveProperty("paused");
		expect(new BotDesk({ file }).state().duties).toHaveLength(2);
	});

	it("gives short unique ids, redrawing one in use", () => {
		const draws = ["aaaa0000", "aaaa0000", "bbbb0000"];
		const desk = new BotDesk({ file: null, newId: () => draws.shift() ?? "cccc0000" });
		const first = desk.addDuty("one").duty;
		const second = desk.addDuty("two").duty;
		expect([first.id, second.id]).toEqual(["aaaa0000", "bbbb0000"]);
		expect(new BotDesk({ file: null }).addDuty("x").duty.id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("takes the same duty text once, and refuses duties past the cap", () => {
		const desk = deskOver();
		const first = desk.addDuty("Watch the release");
		expect(desk.addDuty("  Watch the release ")).toEqual({ duty: first.duty, added: false });
		for (let index = 1; index < BOT_DUTIES_MAX; index++) desk.addDuty(`duty ${index}`);
		expect(desk.state().duties).toHaveLength(BOT_DUTIES_MAX);
		expect(() => desk.addDuty("one too many")).toThrow(BotDeskError);
		expect(() =>
			desk.setDuties({ duties: Array.from({ length: BOT_DUTIES_MAX + 1 }, (_, i) => ({ text: `d${i}` })) }),
		).toThrow(BotDeskError);
		expect(desk.removeDuty(first.duty.id)).toEqual(first.duty);
		expect(desk.removeDuty(first.duty.id)).toBeUndefined();
		expect(desk.addDuty("fits again").added).toBe(true);
	});

	it("setDuties keeps the ids it knows, makes new ones for new rows, and says nothing when nothing changed", () => {
		const desk = deskOver();
		const a = desk.addDuty("alpha").duty;
		const b = desk.addDuty("beta").duty;
		const heard = vi.fn();
		desk.onChange(heard);
		desk.setDuties({
			duties: [
				{ id: b.id, text: "beta" },
				{ id: a.id, text: "alpha" },
			],
		});
		expect(desk.state().duties.map(duty => duty.id)).toEqual([b.id, a.id]);
		expect(heard).toHaveBeenCalledTimes(1);
		desk.setDuties({
			duties: [
				{ id: b.id, text: "beta" },
				{ id: a.id, text: "alpha" },
			],
		});
		expect(heard).toHaveBeenCalledTimes(1);
		desk.setDuties({
			duties: [
				{ id: a.id, text: " alpha, reworded " },
				{ text: "gamma" },
				{ id: "feedfeed", text: "from a stale window" },
				{ id: a.id, text: "alpha again" },
			],
		});
		const after = desk.state().duties;
		expect(after.map(duty => duty.text)).toEqual(["alpha, reworded", "gamma", "from a stale window", "alpha again"]);
		expect(after[0]).toMatchObject({ id: a.id, at: a.at });
		expect(new Set(after.map(duty => duty.id)).size).toBe(4);
		expect(after.some(duty => duty.id === "feedfeed")).toBe(false);
		desk.setDuties({ duties: [] });
		expect(new BotDesk({ file }).state().duties).toEqual([]);
	});

	it("refuses an answer to an unknown or an already answered decision, and keeps the first answer", () => {
		const desk = deskOver();
		const decision = desk.postDecision({ question: "Deploy now?", options: ["Now", "Later"] });
		expect(() => desk.answer("nope0000", "Now")).toThrow('No decision "nope0000" is on the desk.');
		expect(desk.answer(decision.id, "  Later ")).toMatchObject({ state: "answered", answer: "Later" });
		expect(() => desk.answer(decision.id, "Now")).toThrow(`Decision "${decision.id}" was already answered.`);
		expect(desk.state().decisions).toMatchObject([{ id: decision.id, state: "answered", answer: "Later" }]);
	});

	it("keeps the newest answered decisions and never drops an open one", () => {
		const desk = deskOver();
		const open = desk.postDecision({ question: "Still open?" });
		const answeredIds: string[] = [];
		for (let index = 0; index < BOT_DECISIONS_ANSWERED_KEPT + 5; index++) {
			const decision = desk.postDecision({ question: `Question ${index}` });
			desk.answer(decision.id, `Answer ${index}`);
			answeredIds.push(decision.id);
		}
		const { decisions } = desk.state();
		const answered = decisions.filter(decision => decision.state === "answered");
		expect(answered).toHaveLength(BOT_DECISIONS_ANSWERED_KEPT);
		expect(answered.map(decision => decision.id)).toEqual(answeredIds.slice(-BOT_DECISIONS_ANSWERED_KEPT));
		expect(decisions[0]).toMatchObject({ id: open.id, state: "open" });
		expect(openBotDecisions({ decisions })).toHaveLength(1);
	});

	it("reads a missing, corrupt or wrongly shaped file as an empty desk, and writes over it", () => {
		expect(deskOver().state()).toEqual(EMPTY_BOT_DESK_FILE);
		writeFileSync(file, "{ not json");
		const corrupt = deskOver();
		expect(corrupt.state()).toEqual(EMPTY_BOT_DESK_FILE);
		corrupt.addDuty("fresh start");
		expect(JSON.parse(readFileSync(file, "utf8")).duties).toHaveLength(1);
		writeFileSync(file, JSON.stringify({ duties: "x", decisions: [] }));
		expect(deskOver().state()).toEqual(EMPTY_BOT_DESK_FILE);
		// The desk the app starts from is what the schema makes of an empty file.
		expect(BotDeskFileSchema.parse({ duties: [], decisions: [] })).toEqual(EMPTY_BOT_DESK_FILE);
	});

	it("writes the file before it tells anyone", () => {
		const nested = path.join(dir, "deeper", "bot-desk.json");
		const desk = deskOver(nested);
		let seen = "";
		desk.onChange(() => {
			seen = readFileSync(nested, "utf8");
		});
		desk.addDuty("kept");
		expect(JSON.parse(seen).duties[0].text).toBe("kept");
	});

	it("refuses a decision that breaks the contract's limits with a readable reason", () => {
		const desk = deskOver();
		expect(() => desk.postDecision({ question: "   " })).toThrow(BotDeskError);
		expect(() => desk.postDecision({ question: "Pick", options: ["1", "2", "3", "4", "5", "6", "7"] })).toThrow(
			/at most 6 options/,
		);
		expect(desk.state().decisions).toEqual([]);
	});

	it("reads a desk written before identity and memory with their defaults, and keeps them across a restart", () => {
		writeFileSync(
			file,
			JSON.stringify({ duties: [{ id: "d1", text: "Watch CI", at: "2026-10-31T08:00:00.000Z" }], decisions: [] }),
		);
		const desk = deskOver();
		expect(desk.state()).toMatchObject({
			duties: [{ id: "d1", text: "Watch CI" }],
			identity: { tagline: "", persona: "", avatar: { kind: "mark", shape: "bot", color: "accent" } },
			memories: [],
			notify: { progress: "banner", decisions: "both", done: "both", progressEvery: "all" },
			voice: { speakReplies: false },
			channels: [],
		});
		desk.change(
			{ op: "identity", tagline: " Keeps the lights on ", avatar: { kind: "mark", shape: "cat", color: "info" } },
			"owner",
		);
		desk.change({ op: "notify", progress: "quiet", progressEvery: "hourly" }, "owner");
		desk.change({ op: "voice", speakReplies: true }, "owner");
		desk.remember("The owner deploys on Fridays only", "bot");
		desk.addChannel("Release notes", "/s/side.jsonl", "owner");
		const reloaded = new BotDesk({ file }).state();
		expect(reloaded).toEqual(desk.state());
		expect(reloaded).toMatchObject({
			identity: { tagline: "Keeps the lights on", persona: "", avatar: { shape: "cat", color: "info" } },
			notify: { progress: "quiet", decisions: "both", progressEvery: "hourly" },
			voice: { speakReplies: true },
			memories: [{ text: "The owner deploys on Fridays only", by: "bot" }],
			channels: [{ title: "Release notes", sessionPath: "/s/side.jsonl" }],
		});
	});

	it("keeps one memory per text up to the cap, edits, forgets and imports", () => {
		const desk = deskOver(null);
		const first = desk.remember("  Prefers   Korean replies ", "bot");
		expect(first).toMatchObject({ added: true, memory: { text: "Prefers Korean replies" } });
		expect(desk.remember("Prefers Korean replies", "owner")).toEqual({ memory: first.memory, added: false });
		desk.change({ op: "memory_edit", id: first.memory.id, text: "Prefers Korean replies, English code" }, "owner");
		expect(desk.state().memories).toMatchObject([
			{ id: first.memory.id, text: "Prefers Korean replies, English code", by: "owner" },
		]);
		expect(() => desk.change({ op: "memory_edit", id: "nope", text: "x" }, "owner")).toThrow(/No memory/);
		desk.change(
			{ op: "memory_import", texts: ["Lives in Seoul", "Prefers Korean replies, English code"], replace: false },
			"owner",
		);
		expect(desk.state().memories.map(memory => memory.text)).toEqual([
			"Prefers Korean replies, English code",
			"Lives in Seoul",
		]);
		for (let index = desk.state().memories.length; index < BOT_MEMORIES_MAX; index++)
			desk.remember(`fact ${index}`, "bot");
		expect(() => desk.remember("one too many", "bot")).toThrow(/Forget one/);
		desk.change({ op: "memory_import", texts: ["Only this"], replace: true }, "owner");
		expect(desk.state().memories.map(memory => memory.text)).toEqual(["Only this"]);
		expect(desk.forget(desk.state().memories[0]?.id ?? "", "bot")?.text).toBe("Only this");
		expect(desk.forget("gone", "bot")).toBeUndefined();
		expect(desk.state().memories).toEqual([]);
	});

	it("tells the log each change, by whom, with the edit that takes it back", () => {
		const log: BotActivityDraft[] = [];
		const desk = new BotDesk({ file: null, activity: draft => void log.push(draft) });
		desk.addDuty("Watch CI");
		const kept = desk.remember("Deploys on Fridays", "bot").memory;
		desk.forget(kept.id, "owner");
		desk.change({ op: "identity", tagline: "Night shift" }, "owner");
		desk.answer(desk.postDecision({ question: "Ship?" }).id, "Yes");
		expect(log.map(entry => [entry.action, entry.by, entry.text])).toEqual([
			["duty_add", "bot", "Watch CI"],
			["memory_add", "bot", "Deploys on Fridays"],
			["memory_forget", "owner", "Deploys on Fridays"],
			["identity", "owner", "tagline"],
			["decision_post", "bot", "Ship?"],
			["decision_answer", "owner", "Ship? → Yes"],
		]);
		// Replaying each inverse puts the desk back as it was, the forgotten memory with its id.
		for (const entry of log.slice(0, 4).reverse()) {
			const undo = entry.undo;
			if (undo && isDeskChange(undo)) desk.change(undo, "owner");
		}
		expect(desk.state().duties).toEqual([]);
		expect(desk.state().memories).toEqual([]);
		expect(desk.state().identity.tagline).toBe("");
		expect(log.at(-3)).toMatchObject({ action: "memory_restore", undo: { op: "memory_forget", id: kept.id } });
	});

	it("keeps the exact operation and its inputs with the decision, trimmed, through its answer and a reload", () => {
		const desk = deskOver();
		const open = desk.postDecision({
			question: "Release v1.2.0?",
			options: ["Release", "Wait"],
			operation: "  gh release create v1.2.0 --target main ",
			inputs: { " version ": " v1.2.0 ", branch: "main", " ": "dropped" },
		});
		expect(open).toMatchObject({
			operation: "gh release create v1.2.0 --target main",
			inputs: { version: "v1.2.0", branch: "main" },
		});
		const answered = desk.answer(open.id, "Release");
		expect(answered).toMatchObject({ operation: open.operation, inputs: open.inputs, answer: "Release" });
		expect(new BotDesk({ file }).state().decisions).toEqual([answered]);
		const many = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`k${index}`, "v"]));
		expect(() => desk.postDecision({ question: "Too much?", inputs: many })).toThrow(BotDeskError);
	});

	it("pauses and resumes, and keeps the tasks the owner marked done, each logged with the edit that takes it back", () => {
		const log: BotActivityDraft[] = [];
		const desk = new BotDesk({ file, activity: draft => void log.push(draft) });
		desk.change({ op: "paused", paused: true }, "owner");
		desk.change({ op: "paused", paused: true }, "owner");
		desk.change({ op: "tasks_done", sessions: ["/s/a.jsonl", "/s/b.jsonl"], done: true }, "owner");
		desk.change({ op: "tasks_done", sessions: ["/s/a.jsonl"], done: true }, "owner");
		expect(new BotDesk({ file }).state()).toMatchObject({ paused: true, tasksDone: ["/s/a.jsonl", "/s/b.jsonl"] });
		expect(log.map(entry => [entry.action, entry.text, entry.undo])).toEqual([
			["paused", "paused", { op: "paused", paused: false }],
			["task_done", "2", { op: "tasks_done", sessions: ["/s/a.jsonl", "/s/b.jsonl"], done: false }],
		]);
		for (const entry of log.toReversed())
			if (entry.undo && isDeskChange(entry.undo)) desk.change(entry.undo, "owner");
		expect(desk.state()).toMatchObject({ tasksDone: [] });
		expect(desk.state().paused).toBeUndefined();
		desk.change(
			{
				op: "tasks_done",
				sessions: Array.from({ length: 201 }, (_, i) => `/s/${i}.jsonl`).slice(0, 200),
				done: true,
			},
			"owner",
		);
		desk.change({ op: "tasks_done", sessions: ["/s/newest.jsonl"], done: true }, "owner");
		expect(desk.state().tasksDone).toHaveLength(200);
		expect(desk.state().tasksDone.at(-1)).toBe("/s/newest.jsonl");
		expect(desk.state().tasksDone[0]).toBe("/s/1.jsonl");
	});

	it("keeps the owner's edit of the draft with the answer, and refuses an answer once the decision expired", () => {
		const desk = deskOver();
		const email = desk.postDecision({ question: "Send this reply?", draft: "Hi Kim,\nyes.", expiresInMinutes: 10 });
		// Ten minutes from the moment it was posted (the desk's clock reads 09:00:00 then).
		expect(email.expiresAt).toBe("2026-10-31T09:10:00.000Z");
		expect(desk.answer(email.id, "Send", "Hi Kim,\nyes, see you at 3.")).toMatchObject({
			draft: "Hi Kim,\nyes, see you at 3.",
			answer: "Send",
		});
		// Without the owner's edit the bot's own draft stands; a decision without a draft takes none.
		const plain = desk.postDecision({ question: "Ship?", draft: "Release notes" });
		expect(desk.answer(plain.id, "Yes")).toMatchObject({ draft: "Release notes" });
		const bare = desk.postDecision({ question: "Ship again?" });
		expect(desk.answer(bare.id, "Yes", "ignored")).not.toHaveProperty("draft");
		const lapsing = desk.postDecision({ question: "Hold the slot?", expiresInMinutes: 0 });
		expect(() => desk.answer(lapsing.id, "Yes")).toThrow(/expired/);
		expect(desk.state().decisions.find(decision => decision.id === lapsing.id)?.state).toBe("open");
	});
});

describe("botWakes", () => {
	const schedule = (id: string, wakeSession: string | undefined, enabled = true): Schedule => ({
		id,
		name: id,
		prompt: `prompt ${id}`,
		cwd: "/work",
		frequency: { kind: "interval", minutes: 30 },
		model: null,
		autoApprove: false,
		enabled,
		createdAt: "2026-10-31T00:00:00.000Z",
		...(wakeSession === undefined ? {} : { wakeSession }),
	});

	it("lists only the schedules that wake the bot's session, soonest first, paused ones last", () => {
		const wakes = botWakes(
			{
				schedules: [
					schedule("late", "/s/bot.jsonl"),
					schedule("other", "/s/other.jsonl"),
					schedule("plain", undefined),
					schedule("off", "/s/bot.jsonl", false),
					schedule("soon", "/s/bot.jsonl"),
				],
				nextRuns: {
					late: "2026-10-31T12:00:00.000Z",
					other: "2026-10-31T08:00:00.000Z",
					off: "2026-10-31T07:00:00.000Z",
					soon: "2026-10-31T10:00:00.000Z",
				},
			},
			"/s/bot.jsonl",
		);
		expect(wakes).toEqual([
			{ id: "soon", prompt: "prompt soon", next: "2026-10-31T10:00:00.000Z" },
			{ id: "late", prompt: "prompt late", next: "2026-10-31T12:00:00.000Z" },
			{ id: "off", prompt: "prompt off", next: null },
		]);
		expect(botWakes({ schedules: [schedule("late", "/s/bot.jsonl")], nextRuns: {} }, null)).toEqual([]);
	});
});

describe("botDeskText", () => {
	it("is compact and says none for what is empty", () => {
		expect(botDeskText({ ...EMPTY_BOT_DESK })).toBe(
			"Standing duties: none.\nMemories: none.\nOpen decisions: none.\nWakes you scheduled: none.",
		);
		const desk = deskOver(null);
		desk.addDuty("Watch the build");
		const decision = desk.postDecision({
			question: "Ship?",
			options: ["Yes", "No"],
			operation: "gh release create v1.2.0\n--target main",
		});
		const answered = desk.postDecision({ question: "Done already?" });
		desk.answer(answered.id, "Yes");
		expect(
			botDeskText({
				...desk.state(),
				wakes: [{ id: "w1", prompt: "check the\nbuild", next: "2026-10-31T10:00:00.000Z" }],
			}),
		).toBe(
			[
				"Standing duties (1):",
				"- Watch the build (id 00000000)",
				"Memories: none.",
				"Open decisions (1), waiting for the owner:",
				`- ${decision.id}: Ship? [operation: gh release create v1.2.0 --target main] [options: Yes | No] (posted 2026-10-31T09:00:01.000Z)`,
				"Wakes you scheduled (1):",
				"- w1: next 2026-10-31T10:00:00.000Z: check the build",
			].join("\n"),
		);
	});
});
