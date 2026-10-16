/**
 * One viewer's streamed preview page: its offscreen page's paints become paced JPEG frames, the viewer's
 * polls are the acknowledgements, and the JS dialogs the page opens wait here for the viewer's answer.
 *
 * The viewer (a phone) asks `poll({ack})`: the answer is the next frame, held until the pacer
 * (`preview-pacer.ts`) lets one go — never before the viewer acknowledged the last — or a dialog, or an empty
 * answer after `wait` so the socket keeps talking. The paint handler only keeps the newest image and wakes a
 * waiting poll; the JPEG is made when the pacer says send (`toJPEG` is synchronous on main: spike S2 measured
 * 6 ms for a phone frame at 2×, 194 KB), so a page painting at 60 fps costs 12 encodes a second at most, and a
 * still page none. Nothing here touches Electron: the page is an `OsrPage`, so the pacing is tested with a fake.
 */
import type {
	PreviewBounds,
	PreviewStreamDialog,
	PreviewStreamFrame,
	PreviewStreamPoll,
	PreviewStreamPollRequest,
} from "../../shared/preview";
import { FramePacer, type StreamProfile } from "./preview-pacer";

/** The longest a poll is held; a still page answers empty and the viewer asks again. */
export const POLL_MAX_WAIT_MS = 20_000;
/** A page nobody polls for this long stops painting until the next poll (a phone asleep or gone). */
export const IDLE_PAUSE_MS = 15_000;
/** An unanswered dialog is dismissed after this long: the page must not stay blocked on a phone that left. */
export const DIALOG_TIMEOUT_MS = 60_000;
/** A page that opens more dialogs than this in the window is flooding the phone: the rest are dismissed unseen. */
export const DIALOG_FLOOD = { count: 5, windowMs: 10_000 };

/** What a paint hands over: the NativeImage's size, its JPEG, and a smaller copy. */
export interface PaintImage {
	isEmpty(): boolean;
	getSize(): { width: number; height: number };
	toJPEG(quality: number): Buffer;
	resize(options: { width: number; quality?: "good" | "better" | "best" }): PaintImage;
}

/** The slice of an offscreen `WebContents` the stream uses. */
export interface OsrPage {
	/** Listen to paints; returns the unsubscribe. */
	onPaint(listener: (image: PaintImage) => void): () => void;
	setFrameRate(fps: number): void;
	/** Ask for a fresh paint of the whole page (nothing changed, but the viewer needs a frame). */
	invalidate(): void;
	setPainting(painting: boolean): void;
	isDestroyed(): boolean;
}

export interface DialogRequest {
	kind: PreviewStreamDialog["kind"];
	message: string;
	initial: string | null;
}

/** What the page's `alert`, `confirm` and `prompt` get back. */
export type DialogAnswer = { accept: boolean; text: string | null };

export interface StreamGeometry {
	/** Where the frame sits in the viewer's surface, in CSS px. */
	rect: PreviewBounds;
	/** The widest a frame is sent: the surface's CSS width × the profile's pixel ratio. */
	pixelWidth: number;
	profile: StreamProfile;
}

export interface StreamStats {
	/** Frames the page painted, frames sent, bytes of JPEG sent, and ms spent in `toJPEG`. */
	painted: number;
	sent: number;
	bytes: number;
	encodeMs: number;
	dropped: number;
	lost: number;
}

interface Waiter {
	resolve: (poll: PreviewStreamPoll) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface PageStreamOptions {
	page: OsrPage;
	/** The tab the page belongs to; frames carry it so a viewer drops a frame of the tab it left. */
	tab: string;
	geometry: StreamGeometry;
	now?: () => number;
	/** Numbers this page's frames from the viewer's one counter (a tab switch never reuses a number). */
	nextSeq?: () => number;
}

export class PageStream {
	readonly #page: OsrPage;
	readonly #tab: string;
	readonly #pacer: FramePacer;
	readonly #now: () => number;
	#geometry: StreamGeometry;
	#latest: PaintImage | null = null;
	#waiter: Waiter | null = null;
	#schedule: ReturnType<typeof setTimeout> | undefined;
	#idle: ReturnType<typeof setTimeout> | undefined;
	#painting = true;
	#visible = true;
	#disposed = false;
	readonly #stopPaint: () => void;
	readonly #dialogs: Array<{ id: number; request: DialogRequest }> = [];
	readonly #pending = new Map<
		number,
		{ resolve: (answer: DialogAnswer) => void; timer: ReturnType<typeof setTimeout> }
	>();
	#dialogSeq = 0;
	readonly #dialogTimes: number[] = [];
	#painted = 0;
	#sent = 0;
	#bytes = 0;
	#encodeMs = 0;

	constructor(options: PageStreamOptions) {
		this.#page = options.page;
		this.#tab = options.tab;
		this.#geometry = options.geometry;
		this.#now = options.now ?? Date.now;
		this.#pacer = new FramePacer({
			maxFps: options.geometry.profile.maxFps,
			now: this.#now,
			...(options.nextSeq ? { nextSeq: options.nextSeq } : {}),
		});
		this.#page.setFrameRate(options.geometry.profile.maxFps);
		this.#stopPaint = this.#page.onPaint(image => {
			// A paint between a resize and the next layout can be an empty image: there is nothing to show in it.
			if (image.isEmpty()) return;
			this.#painted += 1;
			this.#latest = image;
			this.#pacer.markDirty();
			this.#arm();
		});
		this.#restartIdle();
	}

	/** Answer a waiting poll empty now (the viewer moved to another page: it must poll that one instead). */
	release(): void {
		this.#release({ frame: null, dialogs: [] });
	}

	/** The viewer's surface changed (a rotation, the keyboard, another viewport): the next frame is for the new size. */
	configure(geometry: StreamGeometry): void {
		const resized =
			geometry.pixelWidth !== this.#geometry.pixelWidth ||
			geometry.rect.width !== this.#geometry.rect.width ||
			geometry.rect.height !== this.#geometry.rect.height ||
			geometry.rect.x !== this.#geometry.rect.x ||
			geometry.rect.y !== this.#geometry.rect.y;
		this.#geometry = geometry;
		this.#pacer.setMaxFps(geometry.profile.maxFps);
		this.#page.setFrameRate(geometry.profile.maxFps);
		// The image kept is of the old size; a new one is coming once the page repaints at the new one.
		if (resized) this.refresh();
	}

	/** The panel is covered or closed: the page stops painting and no frame goes out. */
	setVisible(visible: boolean): void {
		if (visible === this.#visible) return;
		this.#visible = visible;
		this.#applyPainting();
		if (visible) this.refresh();
	}

	/** The viewer needs a frame now (a navigation, a tab switch, a resize, a new viewer): repaint, skip the interval. */
	refresh(): void {
		if (this.#disposed) return;
		this.#latest = null;
		this.#pacer.markUrgent();
		if (!this.#page.isDestroyed()) this.#page.invalidate();
	}

	/** The viewer acknowledges `request.ack` and waits for the next frame or dialog. */
	poll(request: PreviewStreamPollRequest): Promise<PreviewStreamPoll> {
		if (this.#disposed) return Promise.resolve({ frame: null, dialogs: [] });
		this.#restartIdle();
		if (!this.#painting) {
			// A viewer is back after an idle pause: paint again and send what the page looks like now.
			this.#painting = true;
			this.#applyPainting();
			this.refresh();
		}
		this.#pacer.ack(request.ack);
		this.#release({ frame: null, dialogs: [] });
		const ready = this.#take();
		if (ready) return Promise.resolve(ready);
		const wait = Math.min(Math.max(0, request.wait ?? POLL_MAX_WAIT_MS), POLL_MAX_WAIT_MS);
		const { promise, resolve } = Promise.withResolvers<PreviewStreamPoll>();
		const timer = setTimeout(() => this.#release({ frame: null, dialogs: [] }), wait);
		this.#waiter = { resolve, timer };
		this.#arm();
		return promise;
	}

	/** Answer the waiting poll (the newest request supersedes an older one: a reconnected viewer has no use for it). */
	#release(poll: PreviewStreamPoll): void {
		const waiter = this.#waiter;
		if (!waiter) return;
		this.#waiter = null;
		clearTimeout(waiter.timer);
		waiter.resolve(poll);
	}

	/** What a poll may carry right now: queued dialogs, and a frame when the pacer allows one. */
	#take(): PreviewStreamPoll | null {
		const dialogs = this.#dialogs.splice(0).map(({ id, request }) => ({ id, ...request }));
		const frame = this.#visible ? this.#frame() : null;
		return frame || dialogs.length > 0 ? { frame, dialogs } : null;
	}

	#frame(): PreviewStreamFrame | null {
		const image = this.#latest;
		if (!image || this.#page.isDestroyed()) return null;
		if (this.#pacer.readiness().state !== "ready") return null;
		const started = performance.now();
		const size = image.getSize();
		const cap = this.#geometry.pixelWidth;
		const sized = cap > 0 && size.width > cap * 1.02 ? image.resize({ width: cap, quality: "good" }) : image;
		const jpeg = sized.toJPEG(this.#pacer.quality());
		this.#encodeMs += performance.now() - started;
		const { width, height } = sized.getSize();
		this.#bytes += jpeg.length;
		this.#sent += 1;
		return {
			seq: this.#pacer.sent(),
			tab: this.#tab,
			width,
			height,
			rect: this.#geometry.rect,
			jpeg: jpeg.toString("base64"),
		};
	}

	/** A poll is waiting: deliver when the pacer allows, else look again when it will. */
	#arm(): void {
		if (!this.#waiter || this.#disposed) return;
		clearTimeout(this.#schedule);
		this.#schedule = undefined;
		const deliver = () => {
			this.#schedule = undefined;
			const ready = this.#take();
			if (ready) this.#release(ready);
			else this.#arm();
		};
		if (this.#dialogs.length > 0) {
			deliver();
			return;
		}
		const readiness = this.#pacer.readiness();
		if (readiness.state === "ready" && this.#latest && this.#visible) {
			// Off the paint's own call: the page's next paint and the socket's work are not held behind the encode.
			this.#schedule = setTimeout(deliver, 0);
		} else if (readiness.state === "wait") {
			this.#schedule = setTimeout(deliver, readiness.ms);
		}
		// `blocked` and `idle`: the viewer's ack or the page's next paint arms again.
	}

	/** The page opened a dialog and is blocked until `answer` (never twice, never after `dispose`). */
	openDialog(request: DialogRequest): Promise<DialogAnswer> {
		const dismissed: DialogAnswer = { accept: false, text: null };
		const now = this.#now();
		while (this.#dialogTimes.length > 0 && now - (this.#dialogTimes[0] ?? now) > DIALOG_FLOOD.windowMs)
			this.#dialogTimes.shift();
		if (this.#disposed || this.#dialogTimes.length >= DIALOG_FLOOD.count) return Promise.resolve(dismissed);
		this.#dialogTimes.push(now);
		const id = ++this.#dialogSeq;
		const { promise, resolve } = Promise.withResolvers<DialogAnswer>();
		const timer = setTimeout(() => this.answerDialog(id, dismissed), DIALOG_TIMEOUT_MS);
		this.#pending.set(id, { resolve, timer });
		this.#dialogs.push({ id, request });
		this.#arm();
		return promise;
	}

	/** The viewer's answer (or a dismissal); an unknown or answered id does nothing. */
	answerDialog(id: number, answer: DialogAnswer): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(answer);
		// The page continues and repaints; the viewer's frame must not wait for the interval.
		this.#pacer.markUrgent();
	}

	stats(): StreamStats {
		const { dropped, lost } = this.#pacer.skipped;
		return { painted: this.#painted, sent: this.#sent, bytes: this.#bytes, encodeMs: this.#encodeMs, dropped, lost };
	}

	#applyPainting(): void {
		if (this.#page.isDestroyed()) return;
		this.#page.setPainting(this.#painting && this.#visible);
	}

	#restartIdle(): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => {
			this.#idle = undefined;
			this.#painting = false;
			this.#applyPainting();
		}, IDLE_PAUSE_MS);
		this.#idle.unref?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopPaint();
		clearTimeout(this.#schedule);
		clearTimeout(this.#idle);
		this.#release({ frame: null, dialogs: [] });
		for (const [id] of [...this.#pending]) this.answerDialog(id, { accept: false, text: null });
		this.#latest = null;
		this.#dialogs.length = 0;
	}
}
