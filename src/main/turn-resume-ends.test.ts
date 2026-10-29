/**
 * When a held connection wait, a reachability probe, a scheduled retry and a continuation on its way end
 * (formal/turn-resume): one world per hold, every end condition applied to it, and random event orders against the
 * model's properties. Seven fixes in two weeks moved these rules one path at a time; this file holds all paths at once.
 */
import { describe, expect, it } from "vitest";
import { seeded, TurnResumeWorld, type WorldEvent, type WorldStart } from "./turn-resume-test-rig";

interface Hold {
	start: WorldStart;
	/** The events that put the tab in the hold. */
	enter: WorldEvent[];
	/** What carries the hold on to its continuation when nothing ends it. */
	heal: WorldEvent[];
}

const prompt: WorldEvent = { type: "prompt" };
const settle: WorldEvent = { type: "settle" };

const HOLDS: Record<string, Hold> = {
	"a probe of a failed lookup": {
		start: {},
		enter: [prompt, { type: "end", kind: "dns" }, settle],
		heal: [{ type: "probe", reachable: false }, { type: "linkUp" }],
	},
	"a failed turn's connection wait": {
		start: { online: false },
		enter: [prompt, { type: "end", kind: "net" }, settle],
		heal: [{ type: "linkUp" }],
	},
	"a launch held offline": {
		start: { marker: "running", online: false },
		enter: [],
		heal: [{ type: "linkUp" }],
	},
	"an armed scheduled retry": {
		start: {},
		enter: [prompt, { type: "end", kind: "transient" }, settle],
		heal: [{ type: "fire" }],
	},
	"a fired scheduled retry whose omp starts": {
		start: {},
		enter: [prompt, { type: "end", kind: "transient" }, settle, { type: "sleep" }, { type: "fire" }],
		heal: [{ type: "boot" }],
	},
	"a flushed wait whose omp starts": {
		start: { online: false },
		enter: [prompt, { type: "end", kind: "net" }, settle, { type: "sleep" }, { type: "linkUp" }],
		heal: [{ type: "boot" }],
	},
	"a launch whose restore runs": {
		start: { marker: "running" },
		enter: [],
		heal: [{ type: "restoreAnswer", turn: false }],
	},
};

const CONDITIONS: Record<string, WorldEvent[]> = {
	"the person's prompt": [prompt],
	Stop: [{ type: "stop" }],
	"a move that counts": [{ type: "moveSend", moves: true }, { type: "moveReply" }],
	"a move that was cancelled": [{ type: "moveSend", moves: false }, { type: "moveReply" }],
	"another session file": [{ type: "fileMoved" }],
	Cancel: [{ type: "cancel" }],
	"the resuming row's Stop": [{ type: "stopResumed" }],
};

/**
 * Today's rules, per hold and condition. `ends`: the row goes at once and nothing continues; `ends at its answer`:
 * the row stays until the hold's own next step, which then sends nothing; `holds`: it continues. A condition that
 * cannot happen in that hold (no Stop on an idle tab, no prompt to an omp still starting) is left out.
 */
const EXPECTED: Record<string, Record<string, "ends" | "ends at its answer" | "holds">> = {
	"a probe of a failed lookup": {
		"the person's prompt": "ends",
		Stop: "ends",
		"a move that counts": "ends at its answer",
		"a move that was cancelled": "holds",
		"another session file": "ends at its answer",
		Cancel: "ends",
	},
	"a failed turn's connection wait": {
		"the person's prompt": "ends",
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		"another session file": "ends",
		Cancel: "ends",
	},
	"a launch held offline": {
		"the person's prompt": "ends",
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		"another session file": "ends",
		Cancel: "ends",
		"the resuming row's Stop": "ends",
	},
	"an armed scheduled retry": {
		"the person's prompt": "ends",
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		// An idle tab's file move reaches the rules only when the timer fires (SidecarPool syncs a running tab or a held wait).
		"another session file": "ends at its answer",
		Cancel: "ends",
	},
	"a fired scheduled retry whose omp starts": {
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		"another session file": "ends",
	},
	"a flushed wait whose omp starts": {
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		"another session file": "ends",
	},
	"a launch whose restore runs": {
		"the person's prompt": "ends",
		"a move that counts": "ends",
		"a move that was cancelled": "holds",
		"another session file": "ends",
		"the resuming row's Stop": "ends",
	},
};

const shown = (world: TurnResumeWorld) => world.awaiting || world.scheduled;

describe("what ends a held wait, a probe, a scheduled retry and a continuation", () => {
	for (const [holdName, hold] of Object.entries(HOLDS)) {
		describe(holdName, () => {
			for (const [conditionName, condition] of Object.entries(CONDITIONS)) {
				const expected = EXPECTED[holdName]?.[conditionName];
				it(`${conditionName}: ${expected ?? "cannot happen"}`, async () => {
					const world = new TurnResumeWorld(hold.start);
					await world.launch();
					for (const event of hold.enter) await world.apply(event);
					const before = world.sent.length;
					const [first] = condition;
					const enabled = world.enabled().some(event => JSON.stringify(event) === JSON.stringify(first));
					expect(enabled).toBe(expected !== undefined);
					if (!first || expected === undefined) return;
					for (const event of condition) await world.apply(event);
					const showing = shown(world);
					for (const event of hold.heal) await world.apply(event);
					const continued = world.sent
						.slice(before)
						.some(type => type === "retry" || type === "restore_interrupted");
					const observed = continued ? "holds" : showing ? "ends at its answer" : "ends";
					expect(observed).toBe(expected);
					expect(world.violations()).toEqual([]);
					expect(await world.drain()).toEqual([]);
				});
			}
		});
	}
});

/** The model's actions as random orders of world events: every order keeps the model's properties. */
describe("random event orders keep formal/turn-resume's properties", () => {
	const STARTS: WorldStart[] = [
		{},
		{ online: false },
		{ marker: "running" },
		{ marker: "running", online: false },
		{ marker: "network", online: false },
		{ marker: "running", ready: false },
	];

	it("holds P1, P2, P4, P5, P8, P9 and P11 at every step, and P3 and P10 once the world heals", async () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= 600 && failures.length === 0; seed++) {
			const random = seeded(seed);
			const start = STARTS[seed % STARTS.length] ?? {};
			const world = new TurnResumeWorld(start);
			await world.launch();
			const steps = 10 + Math.floor(random() * 30);
			for (let step = 0; step < steps; step++) {
				const events = world.enabled();
				const event = events[Math.floor(random() * events.length)];
				if (!event) break;
				await world.apply(event);
				const broken = world.violations();
				if (broken.length > 0) {
					failures.push(`seed ${seed} ${JSON.stringify(start)}: ${broken.join("; ")}\n${world.trace.join("\n")}`);
					break;
				}
			}
			if (failures.length > 0) break;
			const stuck = [...(await world.drain()), ...world.violations()];
			if (stuck.length > 0)
				failures.push(`seed ${seed} ${JSON.stringify(start)}: ${stuck.join("; ")}\n${world.trace.join("\n")}`);
		}
		expect(failures).toEqual([]);
	});
});
