import { describe, expect, it } from "vitest";
import { BOT_CONVERSATIONS_PREF, BOT_MAIN_SLOT, botConversationsOf } from "../../shared/agent-control";
import {
	BOT_HANDOFF_QUESTION,
	BOT_ROTATE_BYTES,
	BotRotation,
	type BotRotationDeps,
	lastBoundary,
	type RotationReason,
} from "./bot-rotation";
import { TurnGate } from "./turn-gate";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A bot whose conversation began at `born` (local time) and whose facts the test sets. */
function rig(born: Date) {
	const prefs = new Map<string, unknown>();
	let now = born.getTime() + HOUR;
	let bot = "/s/bot-1.jsonl";
	let side = "/s/side-1.jsonl";
	let made = 1;
	const facts = {
		quiet: true,
		bytes: 1000,
		answer: "Waiting on the release run (child abc, running)." as string | null,
		removable: true,
	};
	const adopted: { from: string; to: string; note: string; reason: RotationReason }[] = [];
	const removed: string[] = [];
	const asked: string[] = [];
	const deps: BotRotationDeps = {
		prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
		changed: () => {},
		now: () => now,
		slots: () => [
			{ slot: BOT_MAIN_SLOT, path: bot },
			{ slot: "side", path: side },
		],
		bornAt: () => born.getTime(),
		// The bot's own file grows; its side chat stays small.
		bytes: path => (path === bot ? facts.bytes : 1000),
		quiet: () => facts.quiet,
		sideAnswer: async (_path, question) => {
			asked.push(question);
			return facts.answer;
		},
		deskNote: () => "From the desk: 1 open decision.",
		title: async () => "Jarvis",
		create: async title => `/s/bot-${++made}.jsonl#${title}`,
		discard: async () => {},
		gate: new TurnGate(),
		adopt: async input => {
			adopted.push(input);
			if (input.slot === BOT_MAIN_SLOT) bot = input.to;
			else side = input.to;
		},
		remove: async path => {
			if (!facts.removable) return false;
			removed.push(path);
			return true;
		},
		log: () => {},
	};
	const rotation = new BotRotation(deps);
	return {
		rotation,
		facts,
		adopted,
		removed,
		asked,
		state: () => botConversationsOf(prefs.get(BOT_CONVERSATIONS_PREF)),
		bot: () => bot,
		at: (date: Date) => {
			now = date.getTime();
		},
		later: (ms: number) => {
			now += ms;
		},
	};
}

describe("BotRotation", () => {
	it("renews the bot's conversation at the first quiet moment after 04:00, once a day", async () => {
		const r = rig(new Date(2026, 10, 2, 9, 0));
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		r.at(new Date(2026, 10, 3, 3, 59));
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		// Past 04:00 but busy: it waits.
		r.at(new Date(2026, 10, 3, 4, 5));
		r.facts.quiet = false;
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		r.facts.quiet = true;
		r.at(new Date(2026, 10, 3, 6, 30));
		await r.rotation.tick();
		expect(r.adopted.map(entry => entry.reason)).toEqual(["daily"]);
		// The new conversation began after today's boundary: not again today.
		r.at(new Date(2026, 10, 3, 23, 0));
		await r.rotation.tick();
		expect(r.adopted).toHaveLength(1);
		r.at(new Date(2026, 10, 4, 4, 1));
		await r.rotation.tick();
		expect(r.adopted).toHaveLength(2);
	});

	it("renews after two automatic compactions or past the size, at a quiet moment", async () => {
		const r = rig(new Date(2026, 10, 2, 9, 0));
		r.rotation.compacted(r.bot());
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		r.facts.quiet = false;
		r.rotation.compacted(r.bot());
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		r.facts.quiet = true;
		await r.rotation.tick();
		expect(r.adopted.map(entry => entry.reason)).toEqual(["compacted"]);
		expect(r.state().current[BOT_MAIN_SLOT]?.compactions).toBe(0);
		r.facts.bytes = BOT_ROTATE_BYTES + 1;
		await r.rotation.tick();
		expect(r.adopted.map(entry => entry.reason)).toEqual(["compacted", "size"]);
	});

	it("starts a conversation the owner or the bot asked for only once quiet", async () => {
		const r = rig(new Date(2026, 10, 2, 9, 0));
		r.facts.quiet = false;
		expect(r.rotation.request(BOT_MAIN_SLOT, "bot")).toBe(true);
		await r.rotation.tick();
		expect(r.adopted).toEqual([]);
		expect(r.state().current[BOT_MAIN_SLOT]?.requested).toBe("bot");
		r.facts.quiet = true;
		await r.rotation.tick();
		expect(r.adopted.map(entry => entry.reason)).toEqual(["bot"]);
		expect(r.rotation.request("no-such-side-chat", "owner")).toBe(false);
	});

	it("carries the outgoing conversation's own note, else one built from the desk, under the same name", async () => {
		const r = rig(new Date(2026, 10, 2, 9, 0));
		r.rotation.request(BOT_MAIN_SLOT, "owner");
		await r.rotation.tick();
		expect(r.asked).toEqual([BOT_HANDOFF_QUESTION]);
		expect(r.adopted[0]).toMatchObject({
			from: "/s/bot-1.jsonl",
			to: "/s/bot-2.jsonl#Jarvis",
			note: "Waiting on the release run (child abc, running).",
		});
		r.facts.answer = null;
		r.rotation.request(BOT_MAIN_SLOT, "owner");
		await r.rotation.tick();
		expect(r.adopted[1]?.note).toBe("From the desk: 1 open decision.");
		expect(r.state().past.map(entry => entry.path)).toEqual(["/s/bot-1.jsonl", "/s/bot-2.jsonl#Jarvis"]);
	});

	it("keeps every ended conversation of a busy day, the bot's and a side chat's, each until its own 7-day mark", async () => {
		const r = rig(new Date(2026, 10, 2, 9, 0));
		// Nine renewals in one day, five of the bot's and four of its side chat's: more than seven, none deleted.
		for (let index = 0; index < 9; index++) {
			r.rotation.request(index % 2 === 0 ? BOT_MAIN_SLOT : "side", "owner");
			await r.rotation.tick();
			r.later(HOUR);
		}
		const ended = r.state().past.map(entry => entry.path);
		expect(ended).toHaveLength(9);
		expect(r.state().past.filter(entry => entry.slot === "side")).toHaveLength(4);
		expect(r.removed).toEqual([]);
		// Busy from here on, so no renewal mixes in. Just before the first one's 7 days, all stay.
		r.facts.quiet = false;
		r.later(7 * DAY - 9 * HOUR);
		await r.rotation.tick();
		expect(r.removed).toEqual([]);
		// Past the first two marks: those two go, in the order they ended, the rest stay.
		r.later(HOUR + 1);
		await r.rotation.tick();
		expect(r.removed).toEqual(ended.slice(0, 2));
		// The third's mark passes while a tab still runs it: it waits for the next pass.
		r.facts.removable = false;
		r.later(HOUR);
		await r.rotation.tick();
		expect(r.state().past.map(entry => entry.path)).toEqual(ended.slice(2));
		r.facts.removable = true;
		await r.rotation.tick();
		expect(r.removed).toEqual(ended.slice(0, 3));
		expect(r.state().past.map(entry => entry.path)).toEqual(ended.slice(3));
	});

	it("puts the boundary at 04:00 local, the day before when earlier", () => {
		expect(new Date(lastBoundary(new Date(2026, 10, 3, 3, 0).getTime())).getDate()).toBe(2);
		expect(new Date(lastBoundary(new Date(2026, 10, 3, 4, 0).getTime())).getHours()).toBe(4);
	});
});

describe("a renewal never cuts a turn", () => {
	/**
	 * The bot's tab: the file it holds, its running turn, and every message that reached it (with the file it reached).
	 * A message goes through the gate as main's dispatch does, and starts a turn there.
	 */
	function tabRig() {
		const prefs = new Map<string, unknown>();
		const gate = new TurnGate();
		const tab = { file: "/s/old.jsonl", running: false, closed: false, switched: 0 };
		const received: [string, string][] = [];
		const discarded: string[] = [];
		const steps = {
			create: Promise.withResolvers<void>(),
			closeHosted: Promise.withResolvers<void>(),
			adopting: Promise.withResolvers<void>(),
		};
		let slowCreate = false;
		let slowClose = false;
		const send = async (text: string) => {
			const done = await gate.pass(() => tab.file);
			received.push([tab.file, text]);
			tab.running = true;
			done();
		};
		const rotation = new BotRotation({
			prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
			changed: () => {},
			now: () => Date.UTC(2026, 10, 2, 12),
			slots: () => [{ slot: BOT_MAIN_SLOT, path: tab.file }],
			bornAt: () => Date.UTC(2026, 10, 2, 11),
			bytes: () => 0,
			quiet: () => !tab.running,
			sideAnswer: async () => "note",
			deskNote: () => "desk",
			title: async () => "Bot",
			create: async () => {
				if (slowCreate) await steps.create.promise;
				return "/s/new.jsonl";
			},
			discard: async path => void discarded.push(path),
			gate,
			adopt: async ({ from, to }) => {
				// ipc.ts: a paired device's tab on `from` closes first, then the commit (host.ts `botMoveTab`).
				steps.adopting.resolve();
				if (slowClose) await steps.closeHosted.promise;
				if (tab.running) throw new Error("The bot's conversation is busy.");
				expect(tab.file).toBe(from);
				tab.file = to;
				tab.switched++;
			},
			remove: async () => true,
			log: () => {},
		});
		return {
			rotation,
			tab,
			received,
			discarded,
			send,
			steps,
			slow: (step: "create" | "close") => {
				if (step === "create") slowCreate = true;
				else slowClose = true;
			},
		};
	}

	it("lets a turn that starts while the new file is made finish, and leaves everything as it was", async () => {
		const r = tabRig();
		r.slow("create");
		r.rotation.request(BOT_MAIN_SLOT, "bot");
		const renewing = r.rotation.tick();
		await r.send("the owner's message");
		r.steps.create.resolve();
		await renewing;
		expect(r.received).toEqual([["/s/old.jsonl", "the owner's message"]]);
		expect(r.tab).toMatchObject({ file: "/s/old.jsonl", running: true, switched: 0 });
		expect(r.discarded).toEqual(["/s/new.jsonl"]);
	});

	it("holds a message sent while a device's tab closes, and delivers it once, to the new conversation", async () => {
		const r = tabRig();
		r.slow("close");
		r.rotation.request(BOT_MAIN_SLOT, "bot");
		const renewing = r.rotation.tick();
		await r.steps.adopting.promise;
		const sent = r.send("a child's report");
		// Held: nothing reached the tab, and no turn runs to be cut.
		await Promise.resolve();
		expect(r.received).toEqual([]);
		r.steps.closeHosted.resolve();
		await renewing;
		await sent;
		expect(r.received).toEqual([["/s/new.jsonl", "a child's report"]]);
		expect(r.tab.switched).toBe(1);
		expect(r.discarded).toEqual([]);
	});

	it("does the same for the owner's New conversation", async () => {
		const r = tabRig();
		r.slow("close");
		expect(r.rotation.request(BOT_MAIN_SLOT, "owner")).toBe(true);
		const renewing = r.rotation.tick();
		await r.steps.adopting.promise;
		const sent = r.send("the owner's next message");
		r.steps.closeHosted.resolve();
		await renewing;
		await sent;
		expect(r.received).toEqual([["/s/new.jsonl", "the owner's next message"]]);
		expect(r.tab).toMatchObject({ switched: 1, closed: false });
	});
});
