import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_DECISIONS_ANSWERED_KEPT, BOT_DUTIES_MAX, openBotDecisions } from "../../shared/bot-desk";
import type { Schedule } from "../../shared/schedules";
import { BotDesk, BotDeskError, botDeskText, botWakes } from "./bot-desk";

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
		expect(deskOver().state()).toEqual({ duties: [], decisions: [] });
		writeFileSync(file, "{ not json");
		const corrupt = deskOver();
		expect(corrupt.state()).toEqual({ duties: [], decisions: [] });
		corrupt.addDuty("fresh start");
		expect(JSON.parse(readFileSync(file, "utf8")).duties).toHaveLength(1);
		writeFileSync(file, JSON.stringify({ duties: "x", decisions: [] }));
		expect(deskOver().state()).toEqual({ duties: [], decisions: [] });
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
		expect(botDeskText({ duties: [], decisions: [], wakes: [] })).toBe(
			"Standing duties: none.\nOpen decisions: none.\nWakes you scheduled: none.",
		);
		const desk = deskOver(null);
		desk.addDuty("Watch the build");
		const decision = desk.postDecision({ question: "Ship?", options: ["Yes", "No"] });
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
				"Open decisions (1), waiting for the owner:",
				`- ${decision.id}: Ship? [options: Yes | No] (posted 2026-10-31T09:00:01.000Z)`,
				"Wakes you scheduled (1):",
				"- w1: next 2026-10-31T10:00:00.000Z: check the build",
			].join("\n"),
		);
	});
});
