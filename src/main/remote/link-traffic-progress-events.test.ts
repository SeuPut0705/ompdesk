/**
 * A subagent's progress and events over the link with the `events` subscription: the current device gets the frames
 * of one flush in one tab event and its snapshots as deltas, an older device every frame and snapshot whole. The other
 * subscriptions are in `link-traffic-progress.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import { closeSessions, type Delivered, type DeviceKind, delivered, type TaskPartial } from "./link-traffic-test-rig";

afterEach(closeSessions);

describe("a device that asks for slim progress, with the events subscription", () => {
	const scenario = { kind: "subagent", seconds: 3, textTokens: 300, tokenMs: 2 };
	const results = new Map<DeviceKind, Delivered>();
	const run = (device: DeviceKind): Delivered => results.get(device) as Delivered;
	/** The parent's `tool_execution_update`s the omp made: one progress snapshot each. */
	const snapshots = (d: Delivered): number =>
		Math.max(1, d.raw.events.filter(event => event.type === "tool_execution_update").length);
	const perSnapshot = (bytes: number, d: Delivered): number => bytes / snapshots(d);
	const ofKinds = <T extends { type: string }>(items: T[], types: string[]): T[] =>
		items.filter(item => types.includes(item.type));

	beforeAll(async () => {
		for (const device of ["current", "slimEventsOnly", "older"] as const)
			results.set(device, await delivered(scenario, { device, level: "events" }));
	}, 120_000);

	it("sends all of a subagent's events but its own messages in at most a third of the bytes", () => {
		const rest = (d: Delivered): number => perSnapshot(d.tabEventBytes - d.subagentUpdateBytes, d);
		const current = rest(run("current"));
		const before = rest(run("slimEventsOnly"));
		expect(current * 3, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("sends the frames of one flush in one tab event", () => {
		const current = run("current");
		expect(current.raw.frames.length).toBeGreaterThan(100);
		expect(
			current.subagentEnvelopes * 2,
			`${current.subagentEnvelopes} tab events for ${current.raw.frames.length} frames`,
		).toBeLessThanOrEqual(current.raw.frames.length);
	});

	it("delivers the progress snapshots, lifecycle frames and task updates the host's omp emitted, unchanged", () => {
		const current = run("current");
		const updates = ofKinds(current.raw.events, ["tool_execution_update"]);
		expect(updates.length).toBeGreaterThan(10);
		expect(ofKinds(current.events as AgentSessionEvent[], ["tool_execution_update"])).toEqual(updates);
		const frames = ofKinds(current.raw.frames, ["subagent_progress", "subagent_lifecycle"]);
		expect(ofKinds(current.frames, ["subagent_progress", "subagent_lifecycle"])).toEqual(frames);
		expect(frames.length).toBeGreaterThan(10);
	});

	it("still gets every frame and every snapshot whole, one tab event a frame, when it asked for neither", () => {
		const older = run("older");
		expect(older.subagentEnvelopes).toBe(older.raw.frames.length);
		const updates = ofKinds(older.events as AgentSessionEvent[], ["tool_execution_update"]);
		expect(updates).toEqual(ofKinds(older.raw.events, ["tool_execution_update"]));
		for (const update of updates) {
			expect(update.type).toBe("tool_execution_update");
			// The scripted omp's task update: its `partialResult` is `{ details: { progress: AgentProgress[] } }`.
			const partial: TaskPartial = (update as Extract<AgentSessionEvent, { type: "tool_execution_update" }>)
				.partialResult as TaskPartial;
			expect(typeof partial.details?.progress?.[0]?.assignment).toBe("string");
		}
	});
});
