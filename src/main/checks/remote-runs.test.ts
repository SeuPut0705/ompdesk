import { describe, expect, it } from "vitest";
import type { LocalRunAsk, RemoteRun } from "../../shared/checks-contract";
import { sampleAnswer } from "../../shared/checks-fixture";
import { CoreChecksHub } from "./client";
import { relayRemoteRuns } from "./remote-runs";

const ASK: LocalRunAsk = { repo: "o/app", sha: "0123456789abcdef", argv: ["npm", "run", "check"], release: false };

function run(id: string): RemoteRun {
	return { id, device: "mac-mini", ask: ASK };
}

/** A hub that hands out the runs a test places and records what it was told back. */
function hub() {
	const listeners = new Set<(run: RemoteRun) => void>();
	const told: { id: string; outcome: unknown }[] = [];
	let heard: () => void = () => {};
	return {
		told,
		place: (placed: RemoteRun) => {
			for (const listener of listeners) listener(placed);
		},
		answered: (count: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			heard = () => told.length >= count && resolve();
			heard();
			return promise;
		},
		onRemoteRun(listener: (run: RemoteRun) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async remoteAnswer(id: string, outcome: unknown) {
			told.push({ id, outcome });
			heard();
		},
	};
}

describe("checks placed on a paired computer", () => {
	it("go over the link and come back as that computer's answer, or as why none came", async () => {
		const h = hub();
		const asked: [string, LocalRunAsk][] = [];
		const stop = relayRemoteRuns({
			hub: h,
			request: async (device, ask) => {
				asked.push([device, ask]);
				if (device === "mac-mini" && asked.length === 1) return sampleAnswer("there");
				if (asked.length === 2) throw new Error("unsupported: Unknown method checks.runLocal");
				return { not: "an answer" };
			},
			log: () => {},
		});
		h.place(run("chk-1"));
		h.place(run("chk-2"));
		h.place(run("chk-3"));
		await h.answered(3);
		stop();
		expect(asked).toEqual([
			["mac-mini", ASK],
			["mac-mini", ASK],
			["mac-mini", ASK],
		]);
		expect(h.told).toEqual([
			{ id: "chk-1", outcome: { answer: sampleAnswer("there") } },
			{ id: "chk-2", outcome: { error: "unsupported: Unknown method checks.runLocal" } },
			{ id: "chk-3", outcome: { error: "mac-mini answered no check result" } },
		]);
	});

	it("reach main from the core's hub, and its answer reaches the hub", async () => {
		const core = new CoreChecksHub({ fake: true });
		try {
			const { promise: placed, resolve } = Promise.withResolvers<RemoteRun>();
			core.onRemoteRun(resolve);
			await core.id();
			await core.apply({ op: "remoteRun", run: run("chk-9") });
			expect(await placed).toEqual(run("chk-9"));
			await core.remoteAnswer("chk-9", { error: "the link went away" });
			const calls = (await core.apply({ op: "calls" })) ?? [];
			expect(calls.filter(call => call.op === "remoteAnswer").map(call => call.request)).toEqual([
				{ id: "chk-9", error: "the link went away" },
			]);
		} finally {
			await core.close();
		}
	});
});
