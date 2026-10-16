/**
 * The frame pacer of a viewer's streamed preview page (design §7.1, the counterpart of CDP's screencast ack).
 *
 * The page paints whenever it changes; a phone cannot take that. The pacer decides when one frame may be
 * encoded and sent, so a still page costs nothing and a busy one never queues:
 *
 *   - nothing is encoded until the viewer acknowledged the frame before it (`ack`), so a slow link or a slow
 *     decoder skips frames instead of buffering them; only the newest paint is ever kept;
 *   - frames are at least `1000 / maxFps` apart (12 on a phone), measured from the last send, so a burst of
 *     paints cannot exceed the profile's rate;
 *   - a frame whose ack never comes (the page reconnected) is given up after `ACK_TIMEOUT_MS`;
 *   - a navigation or a size change marks the next frame `urgent`: it skips the interval (never the ack), so the
 *     phone sees the new page at once;
 *   - the JPEG quality follows the measured ack round trip: a fast link affords detail, a slow one gets smaller frames.
 */

/** A frame whose ack has not come this long after it was sent is taken as lost. */
export const ACK_TIMEOUT_MS = 3000;
export const QUALITY_MIN = 50;
export const QUALITY_MAX = 80;

/** What a viewer's screen gets: frame rate, pixel density and size caps (spike S2: cost scales with pixels). */
export interface StreamProfile {
	maxFps: number;
	/** The pixel ratio frames are drawn at, at most. */
	dpr: number;
}

/** A phone: at most 12 fps and 2× pixels (a 3× phone is encoded at 2×: 194 KB a frame against 312 KB). */
export const PHONE_PROFILE: StreamProfile = { maxFps: 12, dpr: 2 };
/** A tablet's frame has more pixels, so each gets fewer of them per CSS pixel. */
export const TABLET_PROFILE: StreamProfile = { maxFps: 12, dpr: 1.5 };
/** CSS width below which a viewer is a phone (the shell's own `PHONE_QUERY` width). */
export const PHONE_MAX_CSS_WIDTH = 600;

/** The profile for a surface `cssWidth` wide on a screen with `deviceRatio` pixels per CSS pixel. */
export function streamProfile(cssWidth: number, deviceRatio: number): StreamProfile {
	const base = cssWidth < PHONE_MAX_CSS_WIDTH ? PHONE_PROFILE : TABLET_PROFILE;
	const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
	return { maxFps: base.maxFps, dpr: Math.min(ratio, base.dpr) };
}

export type Readiness =
	/** Encode and send now. */
	| { state: "ready" }
	/** Dirty, but sent too recently: look again in `ms`. */
	| { state: "wait"; ms: number }
	/** The last frame is not acknowledged yet. */
	| { state: "blocked" }
	/** Nothing painted since the last frame. */
	| { state: "idle" };

export interface FramePacerOptions {
	maxFps: number;
	now?: () => number;
	/** Numbers the frames when several pacers share a viewer (one per tab): an ack never names another tab's frame. */
	nextSeq?: () => number;
}

export class FramePacer {
	#maxFps: number;
	readonly #now: () => number;
	readonly #nextSeq: (() => number) | null;
	#dirty = false;
	#urgent = false;
	#seq = 0;
	/** The frame sent and not yet acknowledged, with when. */
	#inFlight: { seq: number; at: number } | null = null;
	#lastSentAt = Number.NEGATIVE_INFINITY;
	/** Smoothed ack round trip in ms; null before the first ack. */
	#rtt: number | null = null;
	#dropped = 0;
	#lost = 0;

	constructor(options: FramePacerOptions) {
		this.#maxFps = options.maxFps;
		this.#now = options.now ?? Date.now;
		this.#nextSeq = options.nextSeq ?? null;
	}

	setMaxFps(fps: number): void {
		this.#maxFps = Math.max(1, fps);
	}

	/** The page painted: a newer picture than the last frame exists. A paint over an unsent one drops that one. */
	markDirty(): void {
		if (this.#dirty) this.#dropped += 1;
		this.#dirty = true;
	}

	/** The next frame must not wait for the interval (a navigation, a resize, a new viewer). */
	markUrgent(): void {
		this.#dirty = true;
		this.#urgent = true;
	}

	/** Frames replaced by a newer paint before they were sent, and frames whose ack never came. */
	get skipped(): { dropped: number; lost: number } {
		return { dropped: this.#dropped, lost: this.#lost };
	}

	get dirty(): boolean {
		return this.#dirty;
	}

	get lastSeq(): number {
		return this.#seq;
	}

	readiness(): Readiness {
		if (!this.#dirty) return { state: "idle" };
		const now = this.#now();
		if (this.#inFlight) {
			if (now - this.#inFlight.at < ACK_TIMEOUT_MS) return { state: "blocked" };
			// The viewer reconnected or died: its ack is not coming.
			this.#inFlight = null;
			this.#lost += 1;
		}
		if (this.#urgent) return { state: "ready" };
		const wait = this.#lastSentAt + 1000 / this.#maxFps - now;
		return wait > 0 ? { state: "wait", ms: Math.ceil(wait) } : { state: "ready" };
	}

	/** A frame is being sent: its number, and the paint it carries is no longer waiting. */
	sent(): number {
		this.#seq = this.#nextSeq ? this.#nextSeq() : this.#seq + 1;
		this.#inFlight = { seq: this.#seq, at: this.#now() };
		this.#lastSentAt = this.#now();
		this.#dirty = false;
		this.#urgent = false;
		return this.#seq;
	}

	/**
	 * The viewer decoded `seq`. An ack of an older frame (or of none: a fresh poll after a reconnect, `null`)
	 * frees the pacer without a measurement.
	 */
	ack(seq: number | null): void {
		const flight = this.#inFlight;
		if (!flight) return;
		if (seq === null || seq >= flight.seq) {
			if (seq === flight.seq) {
				const rtt = this.#now() - flight.at;
				this.#rtt = this.#rtt === null ? rtt : this.#rtt * 0.7 + rtt * 0.3;
			}
			this.#inFlight = null;
		}
	}

	/** JPEG quality for the next frame: the measured round trip decides how much detail the link affords. */
	quality(): number {
		const rtt = this.#rtt;
		if (rtt === null || rtt < 120) return QUALITY_MAX - 5;
		if (rtt < 300) return 65;
		if (rtt < 600) return 58;
		return QUALITY_MIN;
	}

	/** Smoothed ack round trip in ms, for reports. */
	get roundTrip(): number | null {
		return this.#rtt;
	}
}
