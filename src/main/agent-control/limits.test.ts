import { describe, expect, it } from "vitest";
import {
	MAX_MESSAGES_PER_HOUR,
	MAX_MESSAGES_PER_TURN,
	MAX_OPENS_PER_HOUR,
	MAX_OPENS_PER_TURN,
	MAX_PAIR_MESSAGES_PER_MINUTE,
	MAX_RELAY_HOPS,
} from "../../shared/agent-control";
import { AgentLimits, LimitError, RELAY_MEMORY_MS } from "./limits";

function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("AgentLimits opens", () => {
	it("caps the sessions opened in one turn and starts again on the next turn", () => {
		const limits = new AgentLimits(clock().now);
		limits.reserveOpens("a", 1, MAX_OPENS_PER_TURN);
		expect(() => limits.reserveOpens("a", 1, 1)).toThrow(LimitError);
		expect(() => limits.reserveOpens("a", 2, 1)).not.toThrow();
	});

	it("caps the sessions opened per rolling hour, and frees them as the hour passes", () => {
		const time = clock();
		const limits = new AgentLimits(time.now);
		let turn = 0;
		for (let spent = 0; spent < MAX_OPENS_PER_HOUR; spent += MAX_OPENS_PER_TURN)
			limits.reserveOpens("a", ++turn, MAX_OPENS_PER_TURN);
		expect(() => limits.reserveOpens("a", ++turn, 1)).toThrow(/per hour/);
		time.advance(60 * 60_000 + 1);
		expect(() => limits.reserveOpens("a", ++turn, 1)).not.toThrow();
	});

	it("spends nothing when a reservation is refused, and refunds failed opens", () => {
		const limits = new AgentLimits(clock().now);
		expect(() => limits.reserveOpens("a", 1, MAX_OPENS_PER_TURN + 1)).toThrow(LimitError);
		limits.reserveOpens("a", 1, MAX_OPENS_PER_TURN);
		limits.refundOpens("a", 1, 2);
		expect(() => limits.reserveOpens("a", 1, 2)).not.toThrow();
		expect(() => limits.reserveOpens("a", 1, 1)).toThrow(LimitError);
	});

	it("counts each caller on its own", () => {
		const limits = new AgentLimits(clock().now);
		limits.reserveOpens("a", 1, MAX_OPENS_PER_TURN);
		expect(() => limits.reserveOpens("b", 1, 1)).not.toThrow();
	});
});

describe("AgentLimits messages", () => {
	it("refuses a message to oneself", () => {
		expect(() => new AgentLimits(clock().now).reserveMessage("a", "a", 1)).toThrow(/itself/);
	});

	it("caps messages per turn and per hour", () => {
		const time = clock();
		const limits = new AgentLimits(time.now);
		for (let i = 0; i < MAX_MESSAGES_PER_TURN; i++) limits.reserveMessage("a", `t${i}`, 1);
		expect(() => limits.reserveMessage("a", "x", 1)).toThrow(/per turn/);
		let turn = 1;
		let spent = MAX_MESSAGES_PER_TURN;
		while (spent < MAX_MESSAGES_PER_HOUR) {
			turn += 1;
			for (let i = 0; i < MAX_MESSAGES_PER_TURN && spent < MAX_MESSAGES_PER_HOUR; i++, spent++)
				limits.reserveMessage("a", `u${spent}`, turn);
		}
		expect(() => limits.reserveMessage("a", "y", turn + 1)).toThrow(/per hour/);
	});

	it("limits a pair of sessions per minute in both directions, then lets them talk again", () => {
		const time = clock();
		const limits = new AgentLimits(time.now);
		for (let i = 0; i < MAX_PAIR_MESSAGES_PER_MINUTE; i++) limits.reserveMessage("a", "b", 1);
		expect(() => limits.reserveMessage("b", "a", 1)).toThrow(/last minute/);
		time.advance(61_000);
		expect(() => limits.reserveMessage("b", "a", 2)).not.toThrow();
	});

	it("cuts a relay chain at the hop limit, from main-owned lineage, not from anything in the text", () => {
		const limits = new AgentLimits(clock().now);
		const names = ["s0", "s1", "s2", "s3", "s4"];
		for (let hop = 0; hop < MAX_RELAY_HOPS; hop++)
			limits.reserveMessage(names[hop] as string, names[hop + 1] as string, 1);
		expect(() =>
			limits.reserveMessage(names[MAX_RELAY_HOPS] as string, names[MAX_RELAY_HOPS + 1] as string, 1),
		).toThrow(/hop/);
	});

	it("detects an A → B → A relay", () => {
		const limits = new AgentLimits(clock().now);
		limits.reserveMessage("a", "b", 1);
		limits.reserveMessage("b", "a", 1);
		limits.reserveMessage("a", "b", 2);
		expect(() => limits.reserveMessage("b", "a", 2)).toThrow(/hop/);
	});

	it("forgets how far a chain went once its memory expires", () => {
		const time = clock();
		const limits = new AgentLimits(time.now);
		limits.reserveMessage("a", "b", 1);
		limits.reserveMessage("b", "c", 1);
		limits.reserveMessage("c", "d", 1);
		expect(() => limits.reserveMessage("d", "e", 1)).toThrow(/hop/);
		time.advance(RELAY_MEMORY_MS + 1);
		expect(() => limits.reserveMessage("d", "e", 1)).not.toThrow();
	});

	it("forgets a closed session", () => {
		const limits = new AgentLimits(clock().now);
		limits.reserveMessage("a", "b", 1);
		limits.reserveMessage("b", "c", 1);
		limits.forget("b");
		expect(() => limits.reserveMessage("b", "d", 1)).not.toThrow();
	});
});
