/**
 * The "work is going on" cue: a soft light sweeping across what is already on screen, never a new word, a new
 * element that takes space or a border light. A working session's own title shimmers (a sidebar session row, a split
 * pane's header: `LiveText`), and the composer box's background carries the same light at the same pace (`LiveSweep`).
 *
 * States (the one rule is `layout/live-work.ts`):
 * - `turn`: the work in front runs. The full sweep.
 * - `background`: the turn is idle and work it started still runs. The same sweep at the same pace, fainter.
 * - `waiting`: it waits on the person. No sweep; the text (or the box) holds a still warning colour.
 * - `null`: nothing works. Plain text, nothing drawn.
 *
 * Every sweep shares one phase: the animation's delay is set from the document's clock when the work starts, so a
 * row that starts later sweeps in step with the others and a turn ↔ background change never restarts it (same
 * animation, same duration, only the colours differ). Cost rules (components.css `.omp-live-text`/`.omp-live-sweep`):
 * the box's light is one transform animation; a title's is its text's background position; both rest while the
 * window is hidden (`data-paused`), and reduced motion and software compositing (`html[data-gpu="software"]`) draw
 * still text and a still tint with no animation at all.
 */
import { type CSSProperties, type ReactElement, type ReactNode, useMemo, useSyncExternalStore } from "react";
import { cx } from "../../lib/format";

export type LiveState = "turn" | "background" | "waiting";

/** One sweep's period (components.css `--live-period`, both keyframes). */
export const LIVE_PERIOD_MS = 3000;

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}
const documentVisible = () => document.visibilityState !== "hidden";

/** Whether the window is on screen; a hidden one has nothing to animate for. */
export function useWindowVisible(): boolean {
	return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

/**
 * The attributes a working element wears. The delay puts the sweep on the shared phase: an animation starts when the
 * attribute lands (now), so a delay of minus "now within the period" lines it up with every other sweep.
 */
function useLiveAttrs(state: LiveState | null): {
	"data-working"?: LiveState;
	"data-paused"?: "";
	style?: CSSProperties;
} {
	const visible = useWindowVisible();
	const sweeping = state === "turn" || state === "background";
	const style = useMemo(() => {
		if (!sweeping) return undefined;
		const now = Number(document.timeline?.currentTime ?? performance.now());
		return { "--live-delay": `${-Math.round(now % LIVE_PERIOD_MS)}ms` } as CSSProperties;
	}, [sweeping]);
	if (state === null) return {};
	return { "data-working": state, "data-paused": visible ? undefined : "", style };
}

/** Text that shimmers while its session works: the existing words, no new ones. Inline, so it takes no space. */
export function LiveText({
	state,
	className,
	children,
}: {
	state: LiveState | null;
	className?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<span className={cx("omp-live-text", className)} {...useLiveAttrs(state)}>
			{children}
		</span>
	);
}

/** The light across a box's background (the composer); mount it first inside the box. Nothing while idle. */
export function LiveSweep({ state }: { state: LiveState | null }): ReactElement | null {
	const attrs = useLiveAttrs(state);
	if (state === null) return null;
	return <span aria-hidden className="omp-live-sweep" {...attrs} />;
}
