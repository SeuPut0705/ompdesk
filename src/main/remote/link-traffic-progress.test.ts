/**
 * A subagent's progress snapshots over the link with the subscription off and on `progress`: the current device gets
 * them as deltas, a device that asked for slim events only gets them whole. The `events` subscription is in
 * `link-traffic-progress-events.test.ts`, so the two files' sessions run side by side (each run takes a 3 s subagent).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import { closeSessions, type Delivered, type DeviceKind, delivered } from "./link-traffic-test-rig";

afterEach(closeSessions);

describe("a device that asks for slim progress", () => {
	const scenario = { kind: "subagent", seconds: 3, textTokens: 300, tokenMs: 2 };
	const results = new Map<string, Delivered>();
	const key = (device: DeviceKind, level: string): string => `${device} ${level}`;
	const run = (device: DeviceKind, level: string): Delivered => results.get(key(device, level)) as Delivered;
	/** The parent's `tool_execution_update`s the omp made: one progress snapshot each. */
	const snapshots = (d: Delivered): number =>
		Math.max(1, d.raw.events.filter(event => event.type === "tool_execution_update").length);
	const perSnapshot = (bytes: number, d: Delivered): number => bytes / snapshots(d);
	const ofKinds = <T extends { type: string }>(items: T[], types: string[]): T[] =>
		items.filter(item => types.includes(item.type));

	beforeAll(async () => {
		for (const level of ["off", "progress"] as const)
			for (const device of ["current", "slimEventsOnly"] as const)
				results.set(key(device, level), await delivered(scenario, { device, level }));
	}, 120_000);

	it("sends the progress it reports, with the subscription off, in at most half the bytes", () => {
		const current = perSnapshot(run("current", "off").tabEventBytes, run("current", "off"));
		const before = perSnapshot(run("slimEventsOnly", "off").tabEventBytes, run("slimEventsOnly", "off"));
		expect(current * 2, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("sends the progress it reports, with the progress subscription, in at most a third of the bytes", () => {
		const current = perSnapshot(run("current", "progress").tabEventBytes, run("current", "progress"));
		const before = perSnapshot(run("slimEventsOnly", "progress").tabEventBytes, run("slimEventsOnly", "progress"));
		expect(current * 3, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("delivers the progress snapshots, lifecycle frames and task updates the host's omp emitted, unchanged", () => {
		for (const level of ["off", "progress"] as const) {
			const current = run("current", level);
			const updates = ofKinds(current.raw.events, ["tool_execution_update"]);
			expect(updates.length).toBeGreaterThan(10);
			expect(ofKinds(current.events as AgentSessionEvent[], ["tool_execution_update"])).toEqual(updates);
			const frames = ofKinds(current.raw.frames, ["subagent_progress", "subagent_lifecycle"]);
			expect(ofKinds(current.frames, ["subagent_progress", "subagent_lifecycle"])).toEqual(frames);
			if (level !== "off") expect(frames.length).toBeGreaterThan(10);
		}
	});
});
