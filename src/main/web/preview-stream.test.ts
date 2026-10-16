/**
 * A viewer's page stream against a fake offscreen page: frames only after the acknowledgement and at most at
 * the profile's rate, encoding only when a frame is sent, a still page silent, dialogs answered by the viewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_PROFILE } from "./preview-pacer";
import {
	DIALOG_FLOOD,
	DIALOG_TIMEOUT_MS,
	IDLE_PAUSE_MS,
	type OsrPage,
	PageStream,
	type PaintImage,
	POLL_MAX_WAIT_MS,
} from "./preview-stream";

class FakeImage implements PaintImage {
	static encodes = 0;
	constructor(
		readonly width: number,
		readonly height: number,
	) {}
	isEmpty() {
		return this.width === 0 || this.height === 0;
	}
	getSize() {
		return { width: this.width, height: this.height };
	}
	toJPEG(quality: number): Buffer {
		FakeImage.encodes += 1;
		return Buffer.alloc(Math.round(this.width * this.height * (quality / 1000)), 1);
	}
	resize(options: { width: number }): PaintImage {
		return new FakeImage(options.width, Math.round((this.height * options.width) / this.width));
	}
}

class FakePage implements OsrPage {
	listener: ((image: PaintImage) => void) | null = null;
	frameRate = 0;
	invalidations = 0;
	painting: boolean[] = [];
	destroyed = false;
	onPaint(listener: (image: PaintImage) => void) {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}
	setFrameRate(fps: number) {
		this.frameRate = fps;
	}
	invalidate() {
		this.invalidations += 1;
	}
	setPainting(on: boolean) {
		this.painting.push(on);
	}
	isDestroyed() {
		return this.destroyed;
	}
	paint(width = 780, height = 1688) {
		this.listener?.(new FakeImage(width, height));
	}
}

const GEOMETRY = {
	rect: { x: 0, y: 0, width: 390, height: 844 },
	pixelWidth: 780,
	profile: PHONE_PROFILE,
};

function setup() {
	const page = new FakePage();
	const stream = new PageStream({ page, tab: "tab-1", geometry: GEOMETRY });
	return { page, stream };
}

describe("PageStream", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeImage.encodes = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sets the page's frame rate from the profile", () => {
		const { page } = setup();
		expect(page.frameRate).toBe(12);
	});

	it("answers a poll with the paint that arrives, as a JPEG frame for the surface", async () => {
		const { page, stream } = setup();
		const poll = stream.poll({ ack: null });
		await vi.advanceTimersByTimeAsync(20);
		page.paint();
		await vi.advanceTimersByTimeAsync(5);
		const { frame, dialogs } = await poll;
		expect(dialogs).toEqual([]);
		expect(frame).toMatchObject({ seq: 1, tab: "tab-1", width: 780, height: 1688, rect: GEOMETRY.rect });
		expect(Buffer.from(frame?.jpeg ?? "", "base64").length).toBeGreaterThan(0);
	});

	it("sends nothing for a still page: the poll is held, then answers empty after the wait", async () => {
		const { stream } = setup();
		let answered = false;
		const poll = stream.poll({ ack: null, wait: 5000 }).then(result => {
			answered = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(4999);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(await poll).toEqual({ frame: null, dialogs: [] });
		expect(FakeImage.encodes).toBe(0);
	});

	it("caps a hold at the maximum whatever the viewer asked for", async () => {
		const { stream } = setup();
		let answered = false;
		void stream.poll({ ack: null, wait: 10 * 60_000 }).then(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(POLL_MAX_WAIT_MS - 1);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(answered).toBe(true);
	});

	it("sends no second frame before the first is acknowledged, however often the page paints", async () => {
		const { page, stream } = setup();
		page.paint();
		const first = await stream.poll({ ack: null, wait: 100 });
		expect(first.frame?.seq).toBe(1);
		// Acknowledging frame 0 acknowledges nothing: frame 1 is still in flight.
		const held = stream.poll({ ack: 0, wait: 1500 });
		for (let tick = 0; tick < 20; tick++) {
			page.paint();
			await vi.advanceTimersByTimeAsync(50);
		}
		await vi.advanceTimersByTimeAsync(600);
		expect(await held).toEqual({ frame: null, dialogs: [] });
		expect(FakeImage.encodes).toBe(1);
	});

	it("sends the next paint once the poll names the last frame", async () => {
		const { page, stream } = setup();
		page.paint();
		const first = await stream.poll({ ack: null });
		expect(first.frame?.seq).toBe(1);
		page.paint();
		const next = stream.poll({ ack: 1, wait: 3000 });
		// Held until a full frame interval has passed since the last send (83 ms at 12 fps).
		await vi.advanceTimersByTimeAsync(50);
		let early = false;
		void next.then(() => {
			early = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(early).toBe(false);
		await vi.advanceTimersByTimeAsync(50);
		expect((await next).frame?.seq).toBe(2);
	});

	it("never sends more than 12 frames in a second of constant painting, and encodes only what it sends", async () => {
		const { page, stream } = setup();
		let seq: number | null = null;
		const started = Date.now();
		const times: number[] = [];
		const viewer = async () => {
			for (;;) {
				const result = await stream.poll({ ack: seq, wait: 1000 });
				if (!result.frame) return;
				seq = result.frame.seq;
				times.push(Date.now() - started);
			}
		};
		const running = viewer();
		// A page painting every 4 ms (250 paints a second) for 1.3 s.
		for (let elapsed = 0; elapsed < 1300; elapsed += 4) {
			page.paint();
			await vi.advanceTimersByTimeAsync(4);
		}
		stream.dispose();
		await running;
		const inFirstSecond = times.filter(time => time < 1000).length;
		expect(inFirstSecond).toBeLessThanOrEqual(12);
		expect(inFirstSecond).toBeGreaterThanOrEqual(10);
		expect(FakeImage.encodes).toBe(times.length);
		const stats = stream.stats();
		expect(stats.painted).toBeGreaterThan(300);
		expect(stats.sent).toBe(times.length);
		expect(stats.dropped).toBeGreaterThan(250);
	});

	it("scales a frame wider than the surface asks down to its pixel width", async () => {
		const { page, stream } = setup();
		page.paint(1170, 2532);
		const { frame } = await stream.poll({ ack: null });
		expect(frame).toMatchObject({ width: 780, height: 1688 });
	});

	it("refreshing asks the page for a new paint and the next frame skips the interval", async () => {
		const { page, stream } = setup();
		page.paint();
		const first = await stream.poll({ ack: null });
		expect(first.frame?.seq).toBe(1);
		stream.refresh();
		expect(page.invalidations).toBe(1);
		page.paint();
		const next = stream.poll({ ack: 1, wait: 1000 });
		await vi.advanceTimersByTimeAsync(5);
		// Well inside the 83 ms interval, and still sent.
		expect((await next).frame?.seq).toBe(2);
	});

	it("a size change repaints; the same size does not", () => {
		const { page, stream } = setup();
		stream.configure({ ...GEOMETRY });
		expect(page.invalidations).toBe(0);
		stream.configure({ ...GEOMETRY, pixelWidth: 600, rect: { ...GEOMETRY.rect, width: 300 } });
		expect(page.invalidations).toBe(1);
	});

	it("stops painting while hidden and sends no frame, and resumes with a fresh one", async () => {
		const { page, stream } = setup();
		stream.setVisible(false);
		expect(page.painting.at(-1)).toBe(false);
		page.paint();
		let answered = false;
		void stream.poll({ ack: null, wait: 2000 }).then(() => {
			answered = true;
		});
		await vi.advanceTimersByTimeAsync(2001);
		expect(answered).toBe(true);
		expect(stream.stats().sent).toBe(0);
		stream.setVisible(true);
		expect(page.painting.at(-1)).toBe(true);
		expect(page.invalidations).toBe(1);
	});

	it("pauses painting after a quiet spell and resumes on the next poll", async () => {
		const { page, stream } = setup();
		await vi.advanceTimersByTimeAsync(IDLE_PAUSE_MS + 1);
		expect(page.painting.at(-1)).toBe(false);
		const poll = stream.poll({ ack: null, wait: 100 });
		expect(page.painting.at(-1)).toBe(true);
		expect(page.invalidations).toBe(1);
		page.paint();
		await vi.advanceTimersByTimeAsync(5);
		expect((await poll).frame?.seq).toBe(1);
	});

	it("a newer poll supersedes an older one", async () => {
		const { stream } = setup();
		const old = stream.poll({ ack: null, wait: 5000 });
		const current = stream.poll({ ack: null, wait: 100 });
		expect(await old).toEqual({ frame: null, dialogs: [] });
		await vi.advanceTimersByTimeAsync(101);
		expect(await current).toEqual({ frame: null, dialogs: [] });
	});

	it("a page that is gone answers every poll empty", async () => {
		const { stream } = setup();
		const poll = stream.poll({ ack: null, wait: 5000 });
		stream.dispose();
		expect(await poll).toEqual({ frame: null, dialogs: [] });
		expect(await stream.poll({ ack: null })).toEqual({ frame: null, dialogs: [] });
	});
});

describe("PageStream dialogs", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("wakes the poll with the dialog while the page is blocked, and hands the viewer's answer back", async () => {
		const { stream } = setup();
		const poll = stream.poll({ ack: null, wait: 10_000 });
		const answer = stream.openDialog({ kind: "prompt", message: "Name?", initial: "x" });
		const { dialogs, frame } = await poll;
		expect(frame).toBeNull();
		expect(dialogs).toEqual([{ id: 1, kind: "prompt", message: "Name?", initial: "x" }]);
		stream.answerDialog(1, { accept: true, text: "Ada" });
		expect(await answer).toEqual({ accept: true, text: "Ada" });
	});

	it("queues a dialog opened between polls for the next one", async () => {
		const { stream } = setup();
		const answer = stream.openDialog({ kind: "alert", message: "Hi", initial: null });
		const { dialogs } = await stream.poll({ ack: null });
		expect(dialogs.map(dialog => dialog.message)).toEqual(["Hi"]);
		stream.answerDialog(dialogs[0]?.id ?? 0, { accept: true, text: null });
		expect(await answer).toEqual({ accept: true, text: null });
	});

	it("ignores an answer to an unknown or answered dialog", async () => {
		const { stream } = setup();
		const answer = stream.openDialog({ kind: "confirm", message: "Sure?", initial: null });
		stream.answerDialog(99, { accept: true, text: null });
		stream.answerDialog(1, { accept: false, text: null });
		stream.answerDialog(1, { accept: true, text: null });
		expect(await answer).toEqual({ accept: false, text: null });
	});

	it("dismisses a dialog nobody answers, so the page is not blocked for good", async () => {
		const { stream } = setup();
		const answer = stream.openDialog({ kind: "confirm", message: "Sure?", initial: null });
		await vi.advanceTimersByTimeAsync(DIALOG_TIMEOUT_MS + 1);
		expect(await answer).toEqual({ accept: false, text: null });
	});

	it("dismisses every open dialog when the stream ends", async () => {
		const { stream } = setup();
		const answer = stream.openDialog({ kind: "alert", message: "Hi", initial: null });
		stream.dispose();
		expect(await answer).toEqual({ accept: false, text: null });
		expect(await stream.openDialog({ kind: "alert", message: "Late", initial: null })).toEqual({
			accept: false,
			text: null,
		});
	});

	it("dismisses the rest of a flood unseen", async () => {
		const { stream } = setup();
		const answers = Array.from({ length: DIALOG_FLOOD.count + 3 }, (_, index) =>
			stream.openDialog({ kind: "alert", message: `#${index}`, initial: null }),
		);
		const { dialogs } = await stream.poll({ ack: null });
		expect(dialogs).toHaveLength(DIALOG_FLOOD.count);
		for (const dialog of dialogs) stream.answerDialog(dialog.id, { accept: true, text: null });
		const settled = await Promise.all(answers);
		expect(settled.filter(answer => answer.accept)).toHaveLength(DIALOG_FLOOD.count);
	});
});
