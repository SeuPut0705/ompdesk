import { describe, expect, it } from "vitest";
import {
	type AdmissionTicket,
	DEFAULT_EXPECTED_BYTES,
	MemoryAdmission,
	type MemoryReading,
	type MemoryWait,
	RESERVE_WINDOW_MS,
	type SessionFootprint,
	STALE_READING_MS,
	UNREADABLE_NOTICE_FAILURES,
} from "./memory-admission";

const GiB = 1024 ** 3;
const SIXTEEN = 16 * GiB;

function world(peaks: number[] = []) {
	const state = { now: 1_000, running: new Set<string>() };
	const waits: Array<ReadonlyMap<string, MemoryWait>> = [];
	const logs: Array<[string, Record<string, unknown>]> = [];
	const critical: Array<Array<{ tabId: string; bytes: number }>> = [];
	const unreadable: number[] = [];
	const saved: number[][] = [];
	const admission = new MemoryAdmission({
		now: () => state.now,
		changed: next => waits.push(next),
		log: (message, details) => logs.push([message, details]),
		critical: (_reading, top) => critical.push(top),
		unreadable: failures => unreadable.push(failures),
		running: tabId => state.running.has(tabId),
		peaks,
		savePeaks: next => saved.push([...next]),
	});
	const reading = (availableGb: number, pressure: MemoryReading["pressure"] = "normal"): MemoryReading => ({
		totalBytes: SIXTEEN,
		availableBytes: availableGb * GiB,
		pressure,
	});
	const outcomes = new Map<number, string>();
	const ask = (tabId: string, extra: { parentTabId?: string } = {}): AdmissionTicket => {
		const ticket = admission.request({ kind: "open", tabId, label: tabId, ...extra });
		void ticket.outcome.then(outcome => outcomes.set(ticket.id, outcome));
		return ticket;
	};
	const flush = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	const lastWaits = () => waits.at(-1) ?? new Map<string, MemoryWait>();
	return { state, admission, waits, lastWaits, logs, critical, unreadable, saved, reading, ask, outcomes, flush };
}

const agent = (bytes: number, label = "s"): SessionFootprint => ({ bytes, label });

// 2 Nov 2026: one ompdesk_session_open call opened 8 sessions on this 16 GB Mac while memory was still fine; minutes
// later they held about 30 GB and WindowServer stalled.
describe("a burst of agent starts on 16 GB", () => {
	it("starts as many as the predicted headroom allows and holds the rest in order, starting them as measured memory frees", async () => {
		const w = world();
		w.admission.sample(w.reading(12));
		const tickets = Array.from({ length: 8 }, (_, i) => w.ask(`t${i}`));
		await w.flush();
		// 12 GB free, 2.4 GB kept, 2.5 GB expected per start: three fit.
		expect(tickets.map(ticket => ticket.admittedNow)).toEqual([true, true, true, false, false, false, false, false]);
		expect([...w.lastWaits()].map(([tab, wait]) => [tab, wait.position])).toEqual([
			["t3", 1],
			["t4", 2],
			["t5", 3],
			["t6", 4],
			["t7", 5],
		]);
		expect(w.logs.filter(([message]) => message === "memory hold")).toHaveLength(5);

		// The three grew to what was expected: their reservations end, and what is left is what the OS reports.
		const grown = new Map([0, 1, 2].map(i => [`t${i}`, agent(2.6 * GiB)] as const));
		w.admission.sample(w.reading(4.5), grown);
		await w.flush();
		expect(w.lastWaits().size).toBe(5);

		// One of them ends and gives its memory back: the next in line starts, and only it.
		w.state.now += 60_000;
		w.admission.sample(w.reading(7.2), new Map([1, 2].map(i => [`t${i}`, agent(2.6 * GiB)] as const)));
		await w.flush();
		expect(w.outcomes.get(tickets[3]?.id ?? -1)).toBe("admitted");
		expect(w.outcomes.has(tickets[4]?.id ?? -1)).toBe(false);
		expect([...w.lastWaits().keys()]).toEqual(["t4", "t5", "t6", "t7"]);
		expect(w.lastWaits().get("t4")?.position).toBe(1);
		expect(w.logs.filter(([message]) => message === "memory release")).toHaveLength(1);
	});

	it("never lets a later, smaller start skip the line", async () => {
		const w = world();
		w.admission.sample(w.reading(4));
		const first = w.ask("first");
		const second = w.ask("second");
		await w.flush();
		expect([first.admittedNow, second.admittedNow]).toEqual([false, false]);
		w.admission.sample(w.reading(5.5));
		await w.flush();
		expect(w.outcomes.get(first.id)).toBe("admitted");
		expect(w.outcomes.has(second.id)).toBe(false);
	});
});

describe("OS memory pressure", () => {
	it("holds every new start while pressure is warn and releases them when it is normal again", async () => {
		const w = world();
		w.admission.sample(w.reading(12, "warn"));
		const ticket = w.ask("a");
		await w.flush();
		expect(ticket.admittedNow).toBe(false);
		expect(w.lastWaits().get("a")?.pressure).toBe("warn");
		w.admission.sample(w.reading(12, "normal"));
		await w.flush();
		expect(w.outcomes.get(ticket.id)).toBe("admitted");
		expect(w.lastWaits().size).toBe(0);
	});

	it("tells the owner once per critical spell which sessions hold the most memory, and stops nothing", async () => {
		const w = world();
		const trees = new Map([
			["small", agent(0.4 * GiB, "small")],
			["big", agent(6 * GiB, "big")],
			["mid", agent(3 * GiB, "mid")],
			["tiny", agent(0.1 * GiB, "tiny")],
		]);
		w.admission.sample(w.reading(0.8, "critical"), trees);
		w.admission.sample(w.reading(0.7, "critical"), trees);
		expect(w.critical).toHaveLength(1);
		expect(w.critical[0]?.map(entry => entry.tabId)).toEqual(["big", "mid", "small"]);
		expect(w.logs.filter(([message]) => message === "memory critical")).toHaveLength(1);
		w.admission.sample(w.reading(6, "normal"), trees);
		w.admission.sample(w.reading(0.8, "critical"), trees);
		expect(w.critical).toHaveLength(2);
	});

	it("admits nothing before the first good reading, then as that reading allows (a relaunch with a slow sampler)", async () => {
		const w = world();
		const resume = w.admission.request({ kind: "resume", tabId: "r1", label: "r1" });
		const outcome = { value: "" };
		void resume.outcome.then(value => {
			outcome.value = value;
		});
		expect(resume.admittedNow).toBe(false);
		expect(w.lastWaits().get("r1")?.pressure).toBe("unknown");
		w.admission.sample(null);
		await w.flush();
		expect(outcome.value).toBe("");
		w.admission.sample(w.reading(12));
		await w.flush();
		expect(outcome.value).toBe("admitted");
	});
});

// Review of 2 Nov 2026: a sampler that fails (a sysctl or ps stuck under pressure) must never open the guard.
describe("a sample that fails", () => {
	it("keeps holding after a critical reading", async () => {
		const w = world();
		w.admission.sample(w.reading(0.5, "critical"));
		const ticket = w.ask("a");
		w.admission.sample(null);
		await w.flush();
		expect(ticket.admittedNow).toBe(false);
		expect(w.outcomes.has(ticket.id)).toBe(false);
		expect(w.lastWaits().get("a")?.pressure).toBe("critical");
	});

	it("decides from the last good reading while it is fresh", async () => {
		const w = world();
		w.admission.sample(w.reading(12));
		w.state.now += STALE_READING_MS - 1;
		w.admission.sample(null);
		expect(w.ask("a").admittedNow).toBe(true);
	});

	it("holds new work once the last good reading is stale, tells the owner once per failing streak, logs once per streak", async () => {
		const w = world();
		w.admission.sample(w.reading(12));
		for (let i = 0; i < UNREADABLE_NOTICE_FAILURES + 3; i++) {
			w.state.now += STALE_READING_MS / 2;
			w.admission.sample(null);
		}
		const ticket = w.ask("a");
		await w.flush();
		expect(ticket.admittedNow).toBe(false);
		expect(w.lastWaits().get("a")?.pressure).toBe("unknown");
		expect(w.unreadable).toEqual([UNREADABLE_NOTICE_FAILURES]);
		expect(w.logs.filter(([message]) => message === "memory unreadable")).toHaveLength(1);
		// Start now still works.
		expect(w.admission.startNow("a")).toBe(true);
		// A good reading ends the streak (one line) and the next streak is told again.
		w.admission.sample(w.reading(12));
		expect(w.logs.filter(([message]) => message === "memory readable")).toHaveLength(1);
		for (let i = 0; i < UNREADABLE_NOTICE_FAILURES; i++) w.admission.sample(null);
		expect(w.unreadable).toHaveLength(2);
	});

	it("keeps the last measured trees when the process listing failed", () => {
		const w = world();
		w.admission.sample(w.reading(7));
		expect(w.ask("a").admittedNow).toBe(true);
		w.admission.sample(w.reading(7), new Map([["a", agent(2 * GiB)]]));
		w.admission.sample(w.reading(7), null);
		expect(w.admission.status().reservedBytes).toBe(0.5 * GiB);
	});
});

describe("a parent and its children", () => {
	it("a child its opener is blocked waiting on starts under tight memory, so the opener completes", async () => {
		const w = world();
		w.state.running.add("parent");
		w.admission.sample(w.reading(3));
		const child = w.ask("child", { parentTabId: "parent" });
		await w.flush();
		expect(child.admittedNow).toBe(false);
		// The opener calls ompdesk_session_result wait:true on it.
		w.admission.blockedOn("parent", new Set(["child"]));
		await w.flush();
		expect(w.outcomes.get(child.id)).toBe("admitted");
	});

	it("still holds it while pressure is critical, then starts it as soon as pressure eases", async () => {
		const w = world();
		w.admission.sample(w.reading(0.5, "critical"));
		w.admission.blockedOn("parent", new Set(["child"]));
		const child = w.ask("child", { parentTabId: "parent" });
		await w.flush();
		expect(child.admittedNow).toBe(false);
		w.admission.sample(w.reading(1.5, "warn"));
		await w.flush();
		expect(w.outcomes.get(child.id)).toBe("admitted");
	});

	it("nested: a grandchild its blocked child waits on starts too", async () => {
		const w = world();
		w.admission.sample(w.reading(3));
		w.admission.blockedOn("parent", new Set(["child"]));
		w.admission.blockedOn("child", new Set(["grandchild"]));
		const grandchild = w.ask("grandchild", { parentTabId: "child" });
		await w.flush();
		expect(grandchild.admittedNow).toBe(true);
	});

	it("children of a running opener go ahead of unrelated work that asked first", async () => {
		const w = world();
		w.state.running.add("parent");
		w.admission.sample(w.reading(4));
		const unrelated = w.ask("unrelated");
		const child = w.ask("child", { parentTabId: "parent" });
		await w.flush();
		expect([...w.lastWaits()].map(([tab, wait]) => [tab, wait.position])).toEqual([
			["child", 1],
			["unrelated", 2],
		]);
		w.admission.sample(w.reading(5.5));
		await w.flush();
		expect(w.outcomes.get(child.id)).toBe("admitted");
		expect(w.outcomes.has(unrelated.id)).toBe(false);
	});

	it("a wait that ends (answered, timed out, cancelled) takes the child's precedence back", async () => {
		const w = world();
		w.admission.sample(w.reading(3));
		w.admission.blockedOn("parent", new Set(["other"]));
		w.admission.blockedOn("parent", null);
		const child = w.ask("child", { parentTabId: "parent" });
		await w.flush();
		expect(child.admittedNow).toBe(false);
	});
});

// e2e of 2 Nov 2026: a parent's result wait admitted its held child, the wait cleared before the child's message was
// in, and the parent read the child as idle and finished.
describe("a held message", () => {
	it("keeps showing its wait after admission until the message is in, then clears", async () => {
		const w = world();
		w.admission.sample(w.reading(3));
		const sent = Promise.withResolvers<{ type: "response"; command: string; success: true }>();
		let sends = 0;
		const answer = await w.admission.deliver(
			{ kind: "open", tabId: "child", parentTabId: "parent", label: "child" },
			"prompt",
			() => {
				sends++;
				return sent.promise;
			},
		);
		expect(answer).toMatchObject({ success: true, data: { memoryWait: { position: 1 } } });
		w.admission.blockedOn("parent", new Set(["child"]));
		await w.flush();
		expect(sends).toBe(1);
		expect(w.admission.waitOf("child")).toBeDefined();
		sent.resolve({ type: "response", command: "prompt", success: true });
		await w.flush();
		expect(w.admission.waitOf("child")).toBeUndefined();
		expect(w.lastWaits().size).toBe(0);
	});
});

describe("leaving the line", () => {
	it("Start now starts a waiting tab at once and moves the others up", async () => {
		const w = world();
		w.admission.sample(w.reading(2));
		const a = w.ask("a");
		const b = w.ask("b");
		await w.flush();
		expect(w.admission.startNow("b")).toBe(true);
		await w.flush();
		expect(w.outcomes.get(b.id)).toBe("started-now");
		expect(w.outcomes.has(a.id)).toBe(false);
		expect(w.logs.some(([message]) => message === "memory start now")).toBe(true);
		expect(w.admission.startNow("nothing-waits-here")).toBe(false);
	});

	it("a closed tab leaves the line and its start never comes", async () => {
		const w = world();
		w.admission.sample(w.reading(2));
		const a = w.ask("a");
		const b = w.ask("b");
		w.admission.forgetTab("a");
		await w.flush();
		expect(w.outcomes.get(a.id)).toBe("cancelled");
		expect(w.lastWaits().get("b")?.position).toBe(1);
		b.cancel();
		await w.flush();
		expect(w.outcomes.get(b.id)).toBe("cancelled");
		expect(w.lastWaits().size).toBe(0);
	});
});

describe("the expected footprint", () => {
	it("is the default until three agent sessions were measured, then their 90th percentile", async () => {
		const w = world();
		expect(w.admission.expectedBytes).toBe(DEFAULT_EXPECTED_BYTES);
		w.admission.sample(w.reading(14));
		for (const [tab, peak] of [
			["a", 1.2],
			["b", 3.4],
			["c", 1.8],
		] as const) {
			w.ask(tab);
			w.admission.sample(w.reading(14), new Map([[tab, agent(peak * GiB)]]));
			w.state.now += RESERVE_WINDOW_MS;
			w.admission.sample(w.reading(14), new Map([[tab, agent(peak * GiB)]]));
		}
		expect(w.saved.at(-1)?.map(bytes => bytes / GiB)).toEqual([1.2, 3.4, 1.8]);
		expect(w.admission.expectedBytes).toBe(3.4 * GiB);
	});

	it("a turn that ended reserves nothing more", async () => {
		const w = world();
		w.admission.sample(w.reading(7));
		w.ask("a");
		const b = w.ask("b");
		await w.flush();
		expect(b.admittedNow).toBe(false);
		w.admission.turnEnded("a");
		await w.flush();
		expect(w.outcomes.get(b.id)).toBe("admitted");
	});
});
