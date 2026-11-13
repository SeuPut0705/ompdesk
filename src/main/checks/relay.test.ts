import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../../shared/checks-contract";
import { createFakeChecksHub, sampleSnapshot } from "../../shared/checks-fixture";
import type { ChecksFrame, ChecksNames } from "../../shared/checks-frame";
import { ChecksRelay, namesFor } from "./relay";

const NAMES: ChecksNames = { devices: { local: { name: "MacBook", here: true } }, sessions: {}, goals: {} };

function subject(names: () => ChecksNames | Promise<ChecksNames> = () => NAMES) {
	const hub = createFakeChecksHub();
	const sent: ChecksFrame[] = [];
	const lost = new Set<() => void>();
	const relay = new ChecksRelay({
		hub,
		names,
		send: frame => sent.push(frame),
		onLost: listener => {
			lost.add(listener);
			return () => lost.delete(listener);
		},
	});
	const loseHub = () => {
		for (const listener of [...lost]) listener();
	};
	return { hub, relay, sent, loseHub };
}

/** Lets the relay's name read settle. */
const settled = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

describe("ChecksRelay", () => {
	it("sends each snapshot of the hub as a frame with its names, and keeps it for a window that mounts later", async () => {
		const { hub, relay, sent } = subject();
		const stop = relay.start();
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(1_000) });
		await settled();
		expect(sent.at(-1)).toEqual({ snapshot: sampleSnapshot(1_000), names: NAMES, hub: "live" });
		expect(relay.current()).toBe(sent.at(-1));
		stop();
		await hub.apply({ op: "snapshot", snapshot: emptySnapshot(2_000) });
		await settled();
		expect(relay.current()?.snapshot.asOf).toBe(1_000);
	});

	it("pauses through the hub, whose next snapshot says so", async () => {
		const { hub, relay, sent } = subject();
		relay.start();
		await relay.setPaused(true);
		await settled();
		expect(sent.at(-1)?.snapshot.paused).toBe(true);
		expect(await hub.apply({ op: "calls" })).toEqual([{ op: "pause", origin: null, request: true }]);
	});

	it("marks its frame lost when the hub is, until the next snapshot", async () => {
		const { hub, relay, sent, loseHub } = subject();
		relay.start();
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(1_000) });
		await settled();
		loseHub();
		expect(sent.at(-1)).toMatchObject({ hub: "lost", snapshot: { asOf: 1_000 } });
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(3_000) });
		await settled();
		expect(sent.at(-1)).toMatchObject({ hub: "live", snapshot: { asOf: 3_000 } });
	});

	it("never lets the names of an older snapshot replace a newer frame", async () => {
		const reads: PromiseWithResolvers<ChecksNames>[] = [];
		const { hub, relay, sent } = subject(() => {
			const read = Promise.withResolvers<ChecksNames>();
			reads.push(read);
			return read.promise;
		});
		relay.start();
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(1_000) });
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(2_000) });
		// The start's own snapshot, then the two above.
		reads[2]?.resolve(NAMES);
		await settled();
		reads[1]?.resolve(NAMES);
		await settled();
		expect(sent.map(frame => frame.snapshot.asOf)).toEqual([2_000]);
	});

	it("shows a snapshot without names when they cannot be read", async () => {
		const { hub, relay, sent } = subject(() => Promise.reject(new Error("no session index")));
		relay.start();
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot(1_000) });
		await settled();
		expect(sent.at(-1)).toMatchObject({ names: { devices: {}, sessions: {}, goals: {} }, hub: "live" });
	});
});

describe("namesFor", () => {
	it("names the computers and sessions a snapshot holds, and nothing else", () => {
		const names = namesFor(sampleSnapshot(), {
			here: { id: "local", name: "MacBook" },
			hosts: [
				{ deviceId: "mac-mini", name: "Mac mini" },
				{ deviceId: "win", name: "Windows desktop" },
			],
			sessions: [
				{ id: "0a1b2c3d", title: "Ship 1.4" },
				{ id: "4e5f6a7b", title: null, autoTitle: "Search index" },
				{ id: "ffff0000", title: "Not in the snapshot" },
			],
		});
		expect(names).toEqual({
			devices: { local: { name: "MacBook", here: true }, "mac-mini": { name: "Mac mini" } },
			sessions: { "0a1b2c3d": { title: "Ship 1.4" }, "4e5f6a7b": { title: "Search index" } },
			goals: {},
		});
	});
});
