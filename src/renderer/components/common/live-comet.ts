/**
 * Lays the comet on a `LiveEdge` and runs it on the shared clock: measures the edge box, puts the pills in it, gives
 * each pill its one transform animation along the rounded edge, and follows resizes. Loaded the first time a light
 * travels (LiveEdge imports it lazily, so the phone's first screen does not carry it).
 *
 * The pills live in the edge's own shadow root with their own few rules (`PILL_CSS`), so the style an animating pill
 * is given on a main-thread frame is matched against these rules alone, never the app's whole stylesheet; the state's
 * custom properties (`--live-gain`, `--live-trim`, `--live-fade`, `--sc-accent`) still inherit from the edge. Measured
 * this way under four streaming panes (`e2e/flow-performance.e2e.ts` `grid`, lights running vs paused in one
 * session), the lights cost the renderer nothing measurable and the GPU less than the old two-bar light.
 */
import {
	cometShape,
	edgePath,
	LIVE_LIGHT_PERIOD_MS,
	liveClock,
	pillDelay,
	pillKeyframes,
	pillStrength,
} from "./live-light";

/** The pills' look: one stroke per pill from the next pill's strength at its back to its own at its front. */
const PILL_CSS = `
i {
	position: absolute;
	top: -1px;
	left: -1px;
	width: var(--live-pill, 8px);
	height: 1px;
	margin: -0.5px 0 0 calc(var(--live-pill, 8px) / -2);
	background: linear-gradient(90deg, color-mix(in srgb, var(--sc-accent) calc(var(--live-tail) * 100%), transparent), var(--sc-accent));
	opacity: calc(max(0, var(--live-strength) - var(--live-trim)) * var(--live-gain));
	transition: opacity var(--live-fade) ease;
	will-change: transform;
}
i[data-head] {
	height: 1.5px;
	margin-top: -0.75px;
	border-radius: 0 1px 1px 0;
	box-shadow: 0 0 4px 1px color-mix(in srgb, var(--sc-accent) 50%, transparent);
}
@starting-style {
	i { opacity: 0; }
}`;

/** Starts the comet on `edge` (paused when the window is hidden); returns what stops it and takes the pills away. */
export function startComet(edge: HTMLElement, visible: boolean): () => void {
	const root = edge.shadowRoot ?? edge.attachShadow({ mode: "open" });
	if (!root.querySelector("style")) {
		const style = document.createElement("style");
		style.textContent = PILL_CSS;
		root.append(style);
	}
	let pills: HTMLElement[] = [];
	let animations: Animation[] = [];
	const lay = () => {
		const { width, height } = edge.getBoundingClientRect();
		const radius = Number.parseFloat(getComputedStyle(edge).borderTopLeftRadius) || 0;
		const path = edgePath(width, height, radius);
		const comet = cometShape(path.perimeter, path.radius);
		if (pills.length !== comet.count) {
			for (const pill of pills) pill.remove();
			pills = Array.from({ length: comet.count }, (_, rank) => {
				const pill = document.createElement("i");
				pill.className = "omp-live-pill";
				if (rank === 0) pill.dataset.head = "";
				pill.style.setProperty("--live-strength", String(pillStrength(rank, comet.count)));
				// The pill's back end is as strong as the next pill: no step between them.
				pill.style.setProperty(
					"--live-tail",
					String(pillStrength(rank + 1, comet.count) / pillStrength(rank, comet.count)),
				);
				root.append(pill);
				return pill;
			});
			for (const animation of animations) animation.cancel();
			animations = [];
		}
		// Each pill reaches its neighbours, so the tail reads as one stroke.
		edge.style.setProperty("--live-pill", `${(comet.spacing + 0.4).toFixed(2)}px`);
		const keyframes = pillKeyframes(path);
		const origin = liveClock.origin(Number(document.timeline?.currentTime ?? 0), visible);
		animations = pills.map((pill, rank) => {
			const running = animations[rank];
			if (running) (running.effect as KeyframeEffect).setKeyframes(keyframes);
			const animation =
				running ??
				pill.animate(keyframes, { duration: LIVE_LIGHT_PERIOD_MS, iterations: Number.POSITIVE_INFINITY });
			if (visible) animation.startTime = origin + pillDelay(rank, comet, path.perimeter);
			else animation.pause();
			return animation;
		});
	};
	lay();
	const observer = typeof ResizeObserver === "function" ? new ResizeObserver(lay) : null;
	observer?.observe(edge);
	return () => {
		observer?.disconnect();
		for (const animation of animations) animation.cancel();
		for (const pill of pills) pill.remove();
	};
}
