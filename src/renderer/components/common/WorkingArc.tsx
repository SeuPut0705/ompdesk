/**
 * The arc a working session wears where its row's age sits (a sidebar session row, a family child's token): one
 * accent arc that circles while its length eases between a short and a long stroke, over a faint track.
 *
 * The length changes without animating the stroke (a dash animation repaints every frame): two arcs of the same
 * fixed length, the head and the tail, turn on opposite easings (the head ease-out, the tail ease-in), so the head
 * runs up to 133° ahead of the tail and the two read as one stroke of 140°–273°. Two transforms, drawn by the
 * compositor; nothing repaints. The motion is stepped at 24 positions a second on one grid every arc shares (the delay
 * comes from the document clock), so ten arcs cost the compositor one 24 fps stream, not ten 60 fps ones.
 *
 * It rests while the window is hidden (`data-paused`), and reduced motion and software compositing
 * (`html[data-gpu="software"]`) draw it still: a 270° arc that still reads as work going on. `background` only fades
 * its colour. Styles and the generated keyframes: components.css `.omp-working-arc`.
 */
import { type CSSProperties, type ReactElement, useMemo } from "react";
import { useWindowVisible } from "./LiveShimmer";

/** Two eased turns of the head and the tail (components.css `--arc-period`). */
export const WORKING_ARC_PERIOD_MS = 3000;

/** One arc of the stroke: 140 of the circle's 360 path units, from 3 o'clock clockwise. */
function Arc({ part }: { part: "head" | "tail" }): ReactElement {
	return (
		<span className="omp-working-arc-part" data-arc={part}>
			<svg aria-hidden focusable="false" viewBox="0 0 16 16">
				<circle cx="8" cy="8" pathLength="360" r="6" strokeDasharray="140 220" />
			</svg>
		</span>
	);
}

export function WorkingArc({ state }: { state: "turn" | "background" }): ReactElement {
	const visible = useWindowVisible();
	const style = useMemo(() => {
		const now = Number(document.timeline?.currentTime ?? performance.now());
		return { "--arc-delay": `${-Math.round(now % WORKING_ARC_PERIOD_MS)}ms` } as CSSProperties;
	}, []);
	return (
		<span
			aria-hidden
			className="omp-working-arc"
			data-paused={visible ? undefined : ""}
			data-working-arc={state}
			style={style}
		>
			<svg className="omp-working-arc-track" focusable="false" viewBox="0 0 16 16">
				<circle cx="8" cy="8" r="6" />
			</svg>
			<span className="omp-working-arc-stroke">
				<Arc part="tail" />
				<Arc part="head" />
			</span>
		</span>
	);
}
