/** The frame pacer: ack before the next frame, at most the profile's rate, a still page costs nothing. */
import { describe, expect, it } from "vitest";
import {
	ACK_TIMEOUT_MS,
	FramePacer,
	PHONE_PROFILE,
	QUALITY_MAX,
	QUALITY_MIN,
	streamProfile,
	TABLET_PROFILE,
} from "./preview-pacer";

function pacer(maxFps = 12) {
	let now = 10_000;
	const instance = new FramePacer({ maxFps, now: () => now });
	return {
		pacer: instance,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

describe("FramePacer", () => {
	it("sends nothing while the page is still", () => {
		const { pacer: p, advance } = pacer();
		expect(p.readiness()).toEqual({ state: "idle" });
		advance(60_000);
		expect(p.readiness()).toEqual({ state: "idle" });
	});

	it("sends the first paint at once and then holds the next until its ack", () => {
		const { pacer: p, advance } = pacer();
		p.markDirty();
		expect(p.readiness()).toEqual({ state: "ready" });
		expect(p.sent()).toBe(1);
		p.markDirty();
		advance(500);
		expect(p.readiness()).toEqual({ state: "blocked" });
		p.ack(1);
		expect(p.readiness()).toEqual({ state: "ready" });
	});

	it("keeps frames at least one interval apart even when the ack is instant", () => {
		const { pacer: p, advance } = pacer(12);
		p.markDirty();
		p.sent();
		p.ack(1);
		p.markDirty();
		expect(p.readiness()).toEqual({ state: "wait", ms: 84 });
		advance(40);
		expect(p.readiness()).toEqual({ state: "wait", ms: 44 });
		advance(44);
		expect(p.readiness()).toEqual({ state: "ready" });
	});

	it("never exceeds the profile's rate over a second of constant painting", () => {
		for (const fps of [12, 5, 20]) {
			const { pacer: p, advance } = pacer(fps);
			let sent = 0;
			for (let ms = 0; ms < 1000; ms++) {
				p.markDirty();
				if (p.readiness().state === "ready") {
					p.sent();
					p.ack(p.lastSeq);
					sent += 1;
				}
				advance(1);
			}
			expect(sent).toBeLessThanOrEqual(fps);
			expect(sent).toBeGreaterThanOrEqual(fps - 1);
		}
	});

	it("keeps only the newest paint: painting over an unsent one counts a dropped frame, not a queued one", () => {
		const { pacer: p } = pacer();
		p.markDirty();
		p.markDirty();
		p.markDirty();
		expect(p.skipped.dropped).toBe(2);
		p.sent();
		expect(p.dirty).toBe(false);
	});

	it("gives up on an ack that never comes, so a reconnected viewer is fed again", () => {
		const { pacer: p, advance } = pacer();
		p.markDirty();
		p.sent();
		p.markDirty();
		advance(ACK_TIMEOUT_MS - 1);
		expect(p.readiness()).toEqual({ state: "blocked" });
		advance(2);
		expect(p.readiness()).toEqual({ state: "ready" });
		expect(p.skipped.lost).toBe(1);
	});

	it("a poll with no ack (a new connection) frees the frame in flight", () => {
		const { pacer: p } = pacer();
		p.markDirty();
		p.sent();
		p.markDirty();
		p.ack(null);
		expect(p.readiness().state).not.toBe("blocked");
	});

	it("ignores an ack of an older frame", () => {
		const { pacer: p, advance } = pacer();
		p.markDirty();
		p.sent();
		p.ack(1);
		advance(100);
		p.markDirty();
		p.sent();
		p.markDirty();
		p.ack(1);
		expect(p.readiness()).toEqual({ state: "blocked" });
	});

	it("an urgent frame (a navigation) skips the interval but never the ack", () => {
		const { pacer: p } = pacer();
		p.markDirty();
		p.sent();
		p.markUrgent();
		expect(p.readiness()).toEqual({ state: "blocked" });
		p.ack(1);
		expect(p.readiness()).toEqual({ state: "ready" });
	});

	it("lowers the JPEG quality as the viewer's round trip grows and recovers when it shrinks", () => {
		const { pacer: p, advance } = pacer();
		const roundTrip = (ms: number) => {
			p.markUrgent();
			const seq = p.sent();
			advance(ms);
			p.ack(seq);
		};
		expect(p.quality()).toBe(QUALITY_MAX - 5);
		for (let i = 0; i < 12; i++) roundTrip(900);
		expect(p.quality()).toBe(QUALITY_MIN);
		for (let i = 0; i < 24; i++) roundTrip(40);
		expect(p.quality()).toBe(QUALITY_MAX - 5);
	});
});

describe("streamProfile", () => {
	it("caps a phone at 12 fps and 2x pixels, whatever its density", () => {
		expect(streamProfile(390, 3)).toEqual({ maxFps: PHONE_PROFILE.maxFps, dpr: 2 });
		expect(streamProfile(390, 1)).toEqual({ maxFps: 12, dpr: 1 });
		expect(streamProfile(599, 2).maxFps).toBe(12);
	});

	it("gives a tablet fewer pixels per CSS pixel and never more than 12 fps", () => {
		expect(streamProfile(820, 2)).toEqual({ maxFps: TABLET_PROFILE.maxFps, dpr: 1.5 });
		expect(streamProfile(1024, 1)).toEqual({ maxFps: 12, dpr: 1 });
	});

	it("ignores a density that is not a number", () => {
		expect(streamProfile(390, Number.NaN).dpr).toBe(1);
		expect(streamProfile(390, 0).dpr).toBe(1);
	});
});
