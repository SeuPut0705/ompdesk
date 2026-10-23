/**
 * What crosses the remote link, by frame kind, RPC method, tab event name and omp event type, measured on the rig in
 * `link-traffic-test-rig.ts`.
 *
 * `OMP_GUI_LINK_TRAFFIC=1 bunx vitest run src/main/remote/link-traffic-report.test.ts` prints the tables (idle seconds from
 * `OMP_GUI_LINK_TRAFFIC_IDLE_S`, default 120); without it the file only pins the regressions below. A subagent's
 * progress snapshots are pinned in `link-traffic-progress.test.ts` and `link-traffic-progress-events.test.ts`.
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import {
	closeSessions,
	type Delivered,
	type DeviceKind,
	delivered,
	type LinkRecorder,
	openSession,
} from "./link-traffic-test-rig";

const MEASURE = process.env.OMP_GUI_LINK_TRAFFIC === "1";

afterEach(closeSessions);

describe.skipIf(!MEASURE)("link traffic report", () => {
	const idleSeconds = Number(process.env.OMP_GUI_LINK_TRAFFIC_IDLE_S) || 120;
	const report = (title: string, recorder: LinkRecorder, ms: number): void => {
		console.log(`\n${recorder.table(title, ms / 1000)}\n`);
	};

	it("idle: an open tab, no turn, no subagent", async () => {
		const { recorder } = await openSession();
		await delay(1_000);
		recorder.reset();
		await delay(idleSeconds * 1000);
		report(`idle tab`, recorder, idleSeconds * 1000);
	}, 400_000);

	it("a turn waiting on a long tool call", async () => {
		const { recorder, turn } = await openSession();
		await delay(500);
		recorder.reset();
		const started = Date.now();
		await turn({ kind: "tool-wait", seconds: 30 });
		report("turn waiting 30 s on a silent bash tool (level off)", recorder, Date.now() - started);
	}, 120_000);

	it("assistant streaming a long message with thinking", async () => {
		const { recorder, turn } = await openSession();
		for (const [thinking, text] of [
			[150, 300],
			[300, 600],
			[600, 1200],
		] as const) {
			await delay(500);
			recorder.reset();
			const started = Date.now();
			await turn({ kind: "stream", thinkingTokens: thinking, textTokens: text, tokenMs: 12 });
			report(
				`stream ${thinking} thinking + ${text} text tokens, one token per 12 ms`,
				recorder,
				Date.now() - started,
			);
		}
	}, 200_000);

	for (const level of ["off", "progress", "events"] as const) {
		it(`a task tool whose subagent works for 20 s (subscription ${level})`, async () => {
			const { recorder, turn, setLevel } = await openSession();
			await setLevel(level);
			await delay(500);
			recorder.reset();
			const started = Date.now();
			await turn({ kind: "subagent", seconds: 20, textTokens: 300, tokenMs: 12 });
			report(`task subagent, subscription ${level}`, recorder, Date.now() - started);
		}, 120_000);
	}
});

describe("deflated frames by the device's build", () => {
	it("an older device's hello turns no deflate on: its host sends it every frame as JSON", async () => {
		const slimOf = async (device: DeviceKind): Promise<string> => {
			const { hostLog } = await openSession({ device });
			const open = hostLog.find(line => line.message === "open");
			return String((open?.details as { slim?: string } | undefined)?.slim);
		};
		expect((await slimOf("current")).split(",")).toContain("deflate");
		for (const device of ["noDeflate", "noListReads", "slimEventsOnly", "older"] as const)
			expect((await slimOf(device)).split(",")).not.toContain("deflate");
	}, 60_000);
});

describe("link traffic harness", () => {
	it("counts a request, its answer and a tab event by kind", async () => {
		const { sidecar, recorder } = await openSession();
		recorder.reset();
		await sidecar.rpcClient?.command({ type: "get_state" });
		expect([...recorder.links.keys()]).toEqual(["A>B req tab.command", "B>A res tab.command"]);
		expect(recorder.totalBytes).toBeGreaterThan(0);
	}, 30_000);
});

describe("the host's traffic line over the real pipeline", () => {
	it("names the omp event type a streamed reply is made of, and holds none of its text", async () => {
		// Deflated, the scripted reply's repeated words stay under the line's 256 KiB floor.
		const { rig, turn, hostLog } = await openSession({ device: "noDeflate" });
		await turn({ kind: "stream", thinkingTokens: 400, textTokens: 1200, tokenMs: 0 });
		await rig.dispose();

		const traffic = hostLog.filter(line => line.message === "traffic");
		expect(traffic).toHaveLength(1);
		const details = traffic[0]?.details as { top: string; events: string; eventBytes: string };
		const top = JSON.parse(details.top) as Array<{ kind: string }>;
		const events = JSON.parse(details.events) as Record<string, number>;
		const eventBytes = JSON.parse(details.eventBytes) as Record<string, number>;
		expect(top[0]?.kind).toBe("tx evt tab.event events");
		expect(events.message_update).toBeGreaterThan(1500);
		// Each type weighed on its own: a slim stream's updates are a couple of hundred bytes each, and the message_end
		// that carries the whole reply once is told apart from them.
		expect((eventBytes.message_update ?? 0) / (events.message_update ?? 1)).toBeLessThan(400);
		expect(eventBytes.message_end ?? 0).toBeGreaterThan(1200);
		expect(JSON.stringify(details)).not.toContain("session transcript");
	}, 30_000);
});

describe("a device that asks for slim events", () => {
	it.each([
		[150, 300],
		[300, 600],
		[600, 1200],
	] as const)(
		"streams a reply of %i thinking + %i text tokens in at most a tenth of the bytes an older device gets",
		async (thinkingTokens, textTokens) => {
			// Unpaced: a byte count needs no wall clock (2 ms a token was 7 of the 1800-token case's 9.5 s), and a burst
			// is what packs an older device's whole updates into frames past the link's cap.
			const scenario = { kind: "stream", thinkingTokens, textTokens, tokenMs: 0 };
			const older = await delivered(scenario, { device: "older" });
			const current = await delivered(scenario);
			const updates = (run: Delivered) => run.events.filter(event => event.type === "message_update").length;
			// Nothing dropped on the way: an older device's batch past the frame cap once lost the turn, end included.
			expect(updates(older)).toBeGreaterThanOrEqual(thinkingTokens + textTokens);
			expect(updates(older)).toBe(updates(current));
			expect(current.eventBytes * 10, `${current.eventBytes} B against ${older.eventBytes} B`).toBeLessThanOrEqual(
				older.eventBytes,
			);
		},
		30_000,
	);

	it("receives a subagent's streamed messages in at most a tenth of the bytes an older device gets", async () => {
		const scenario = { kind: "subagent", messages: 1, textTokens: 300, tokenMs: 0 };
		const older = await delivered(scenario, { device: "older", level: "events" });
		const current = await delivered(scenario, { level: "events" });
		const perFrame = (bytes: number, frames: number): number => bytes / Math.max(1, frames);
		expect(older.subagentUpdateFrames).toBeGreaterThan(100);
		expect(
			perFrame(current.subagentUpdateBytes, current.subagentUpdateFrames) * 10,
			`${current.subagentUpdateBytes} B in ${current.subagentUpdateFrames} frames against ${older.subagentUpdateBytes} B in ${older.subagentUpdateFrames}`,
		).toBeLessThanOrEqual(perFrame(older.subagentUpdateBytes, older.subagentUpdateFrames));
	}, 120_000);

	it("still gets every message_update whole from a host that cannot tell the device is older", async () => {
		const older = await delivered(
			{ kind: "stream", thinkingTokens: 20, textTokens: 40, tokenMs: 0 },
			{ device: "older" },
		);
		const updates = older.events.filter(event => event.type === "message_update");
		expect(updates.length).toBeGreaterThan(60);
		for (const update of updates) expect(Array.isArray(update.message?.content)).toBe(true);
	}, 30_000);

	it("receives a tool result's output once, where an older device gets it twice", async () => {
		const scenario = { kind: "tool-wait", seconds: 0 };
		const starts = async (device: DeviceKind) => {
			const session = await openSession({ device });
			session.recorder.reset();
			await session.turn(scenario);
			const bytes = session.recorder.inner.get("events/message_start")?.bytes ?? 0;
			const ends = session.recorder.inner.get("events/tool_execution_end")?.bytes ?? 0;
			session.recorder.stop();
			await session.rig.dispose();
			return { bytes, ends };
		};
		const older = await starts("older");
		const current = await starts("current");
		// The output (about 7 KB) rides the end on both; the older device's result message carries it again.
		expect(current.ends).toBe(older.ends);
		expect(older.bytes - current.bytes, `${current.bytes} B against ${older.bytes} B`).toBeGreaterThan(
			older.ends * 0.9,
		);
	}, 60_000);

	it("receives a running tool's output as what follows each update, a tenth of what an older device gets", async () => {
		const scenario = { kind: "tool-wait", seconds: 0, outputLines: 150 };
		const updates = async (device: DeviceKind) => {
			const session = await openSession({ device });
			session.recorder.reset();
			await session.turn(scenario);
			const bytes = session.recorder.inner.get("events/tool_execution_update")?.bytes ?? 0;
			session.recorder.stop();
			await session.rig.dispose();
			return bytes;
		};
		const older = await updates("older");
		const current = await updates("current");
		expect(older).toBeGreaterThan(300_000);
		expect(current * 10, `${current} B against ${older} B`).toBeLessThanOrEqual(older);
	}, 60_000);

	it("delivers the same stream to the renderer as an older device does", async () => {
		const scenario = { kind: "tool-wait", seconds: 0, outputLines: 40 };
		const rendered = async (options: { device?: DeviceKind }) => {
			// The pool's per-window slimmer turns what a sidecar delivers into what a window receives.
			const slim = createMessageUpdateSlimmer();
			return slim((await delivered(scenario, options)).events as AgentSessionEvent[]);
		};
		const older = await rendered({ device: "older" });
		const current = await rendered({});
		expect(current).toEqual(older);
	}, 60_000);
});

describe("a device that asks for slim list reads", () => {
	/** Two reads of the slash command list on one connection, as two hydrations of the tab ask it. */
	const twice = async (device: DeviceKind) => {
		const session = await openSession({ device });
		const read = () => session.sidecar.rpcClient?.command({ type: "get_available_commands" });
		const first = (await read())?.data;
		session.recorder.reset();
		const second = (await read())?.data;
		const bytes = session.recorder.links.get("B>A res tab.command")?.bytes ?? 0;
		// Its spy on Link.send goes now: the next session's hello must not pass through this one's.
		session.recorder.stop();
		await session.rig.dispose();
		return { first, second, bytes };
	};

	it("receives the command list again in at most a twentieth of the bytes an earlier device gets, the same list", async () => {
		const earlier = await twice("noListReads");
		const current = await twice("current");
		expect(current.second).toEqual(earlier.second);
		expect(current.second).toEqual(current.first);
		expect((current.second as { commands?: unknown[] }).commands).toHaveLength(300);
		expect(current.bytes * 20, `${current.bytes} B against ${earlier.bytes} B`).toBeLessThanOrEqual(earlier.bytes);
	}, 30_000);
});
