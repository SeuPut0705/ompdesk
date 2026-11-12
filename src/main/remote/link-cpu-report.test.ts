/**
 * What a link costs main's thread, both ends in this process, on the rig of `link-traffic-test-rig.ts`: the scripted
 * reply of 450, 900 and 1800 tokens streamed from a host's tab to a device. A CPU profile of each turn attributes
 * every sample to the innermost frame of this repository's code above it (node's internals, zlib, crypto and JSON
 * count for the code that called them); `LINK_FILES` is the link's own code in main, so the rest (the sidecar, the
 * slim encoders, the host's services) is the same work in any build and is reported apart.
 * Opt-in: `OMP_GUI_LINK_CPU=1 bunx vitest run src/main/remote/link-cpu-report.test.ts` (rounds from
 * `OMP_GUI_LINK_CPU_ROUNDS`, default 5).
 */
import { Session as InspectorSession } from "node:inspector/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, it } from "vitest";
import { closeSessions, openSession } from "./link-traffic-test-rig";

const MEASURE = process.env.OMP_GUI_LINK_CPU === "1";
const ROUNDS = Number(process.env.OMP_GUI_LINK_CPU_ROUNDS) || 5;
/** Main's side of a link: framing, sealing, deflating and the traffic line, or the pipe to the core that does them. */
const LINK_FILES = [/remote[\\/]wire\.ts$/, /remote[\\/]link-traffic\.ts$/, /core[\\/]process\.ts$/];
const OWN_CODE = /[\\/]src[\\/](main|shared)[\\/]/;

afterEach(closeSessions);

interface ProfileNode {
	id: number;
	callFrame: { url: string; functionName: string };
	children?: number[];
}

/** Microseconds of the link's own code and of everything, from one profile. */
function linkTime(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }): {
	link: number;
	total: number;
} {
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	const parent = new Map<number, number>();
	for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
	const owner = new Map<number, boolean>();
	const isLink = (id: number): boolean => {
		const known = owner.get(id);
		if (known !== undefined) return known;
		let at: number | undefined = id;
		let found = false;
		while (at !== undefined) {
			const url = byId.get(at)?.callFrame.url ?? "";
			if (OWN_CODE.test(url)) {
				found = LINK_FILES.some(file => file.test(url));
				break;
			}
			at = parent.get(at);
		}
		owner.set(id, found);
		return found;
	};
	let link = 0;
	let total = 0;
	for (const [index, id] of profile.samples.entries()) {
		const us = profile.timeDeltas[index] ?? 0;
		const node = byId.get(id);
		if (node?.callFrame.functionName === "(idle)") continue;
		total += us;
		if (isLink(id)) link += us;
	}
	return { link, total };
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe.skipIf(!MEASURE)("main's CPU per link frame", () => {
	it("streams 450, 900 and 1800 tokens from a host's tab", async () => {
		const { recorder, turn } = await openSession();
		const session = new InspectorSession();
		session.connect();
		await session.post("Profiler.enable");
		await session.post("Profiler.setSamplingInterval", { interval: 100 });
		const lines: string[] = [];
		for (const [thinking, text] of [
			[150, 300],
			[300, 600],
			[600, 1200],
		] as const) {
			const link: number[] = [];
			const total: number[] = [];
			const frames: number[] = [];
			for (let round = 0; round < ROUNDS; round++) {
				await delay(300);
				recorder.reset();
				await session.post("Profiler.start");
				await turn({ kind: "stream", thinkingTokens: thinking, textTokens: text, tokenMs: 4 });
				const { profile } = await session.post("Profiler.stop");
				const time = linkTime(profile as never);
				link.push(time.link / 1000);
				total.push(time.total / 1000);
				frames.push([...recorder.links.values()].reduce((sum, row) => sum + row.frames, 0));
			}
			const count = median(frames);
			const linkMs = median(link);
			lines.push(
				`${String(thinking + text).padStart(5)} tokens: ${String(count).padStart(4)} link frames, link ${linkMs.toFixed(1).padStart(6)} ms (${((linkMs * 1000) / count).toFixed(1).padStart(6)} us a frame), main busy ${median(total).toFixed(1).padStart(7)} ms; link rounds ${link.map(v => v.toFixed(1)).join(" ")}`,
			);
		}
		session.disconnect();
		console.log(`== main's CPU on a link (median of ${ROUNDS})\n${lines.join("\n")}`);
	}, 600_000);
});
