/**
 * The motion system's script side (docs/motion-design.md). Stylesheets own every duration, curve and distance as a
 * token (`styles/tokens.css`); this module reads the same tokens for what CSS cannot do alone: a presence hook's exit
 * timer here, a list's reflow (FLIP), a height that opens or closes and a leaving overlay's clone in `motion-play.ts`,
 * loaded after the first screen. Motion is off (every duration 0) under reduced motion, software compositing and in a
 * hidden document, the same places the stylesheets go still.
 */
import type * as MotionPlayModule from "./motion-play";

export type MotionDuration = "instant" | "fast" | "med" | "slow";
export type MotionEase = "standard" | "enter" | "exit" | "emphasized" | "spring";

/** The token values as tokens.css ships them: what a page without the stylesheet (a unit test) reads. */
const DURATION_FALLBACK: Record<MotionDuration, number> = { instant: 90, fast: 150, med: 220, slow: 320 };
const EASE_FALLBACK: Record<MotionEase, string> = {
	standard: "cubic-bezier(0.25, 1, 0.35, 1)",
	enter: "cubic-bezier(0.16, 1, 0.3, 1)",
	exit: "cubic-bezier(0.4, 0, 1, 1)",
	emphasized: "cubic-bezier(0.32, 0.72, 0, 1)",
	spring: "cubic-bezier(0.16, 1, 0.3, 1)",
};

interface Tokens {
	durations: Record<MotionDuration, number>;
	eases: Record<MotionEase, string>;
	/** `--sc-motion-stagger`, ms. */
	stagger: number;
	/** `--sc-motion-rise`, px. */
	rise: number;
}

/** Tokens as the page first read them; they never change while it runs. */
let tokens: Tokens | null = null;

function parseMs(value: string): number | null {
	const match = /^(-?[\d.]+)(ms|s)$/.exec(value);
	if (!match) return null;
	return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

function readTokens(): Tokens {
	if (tokens) return tokens;
	const read: Tokens = { durations: { ...DURATION_FALLBACK }, eases: { ...EASE_FALLBACK }, stagger: 30, rise: 6 };
	const root = typeof document === "undefined" ? null : document.documentElement;
	const style = root && typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
	const value = (name: string) => style?.getPropertyValue(name).trim().replace(/\s+/g, " ") ?? "";
	let complete = style != null;
	for (const name of Object.keys(read.durations) as MotionDuration[]) {
		const ms = parseMs(value(`--sc-duration-${name}`));
		if (ms === null) complete = false;
		// Zero is reduced motion or software compositing overriding the token: the scale stays the shipped one.
		else if (ms > 0) read.durations[name] = ms;
	}
	for (const name of Object.keys(read.eases) as MotionEase[]) {
		const ease = value(`--sc-ease-${name}`);
		if (ease) read.eases[name] = ease;
		else complete = false;
	}
	const stagger = parseMs(value("--sc-motion-stagger"));
	if (stagger !== null && stagger > 0) read.stagger = stagger;
	const rise = Number.parseFloat(value("--sc-motion-rise"));
	if (Number.isFinite(rise)) read.rise = rise;
	// Only a page that has its stylesheet keeps the read; before it loads, read again next time.
	if (complete) tokens = read;
	return read;
}

/**
 * Whether motion runs at all: not under reduced motion, software compositing (`html[data-gpu="software"]`) or in a
 * hidden document.
 */
export function motionAllowed(): boolean {
	if (typeof document === "undefined" || document.hidden) return false;
	if (document.documentElement?.dataset.gpu === "software") return false;
	const media = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-reduced-motion: reduce)");
	return media?.matches !== true;
}

/** A duration token in milliseconds, 0 wherever motion is off. */
export function motionMs(duration: MotionDuration): number {
	return motionAllowed() ? readTokens().durations[duration] : 0;
}

/** A curve token as a timing function Web Animations accepts. */
export function motionEase(ease: MotionEase): string {
	return readTokens().eases[ease];
}

/** Forget the tokens read so far (a test that swaps the stylesheet). */
export function resetMotionTokens(): void {
	tokens = null;
}

/** How far things travel: `--sc-motion-stagger` (ms) and `--sc-motion-rise` (px). */
export function motionTravel(): { stagger: number; rise: number } {
	const { stagger, rise } = readTokens();
	return { stagger, rise };
}

/**
 * A bubbling event an element's own size motion sends when it has settled (a `Collapse` that finished opening or
 * closing): a list gliding its rows (`useListMotion`) reads where they rest now.
 */
export const MOTION_SETTLED = "omp-motion-settled";

type MotionPlay = typeof MotionPlayModule;
let play: MotionPlay | null = null;
let loading: Promise<MotionPlay> | null = null;

/** The play-time code (lists, heights, leaving overlays) once loaded; null in the moments before. */
export function motionPlay(): MotionPlay | null {
	return play;
}

/**
 * Load the play-time code (`lib/motion-play.ts`). main.tsx starts it right after the first screen, so the paired
 * phone's first screen does not carry it; a list or a disclosure that changes before it lands just changes at once.
 */
export function loadMotionPlay(): Promise<MotionPlay> {
	loading ??= import("./motion-play").then(module => {
		play = module;
		return module;
	});
	return loading;
}
