import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Read the same token CSS uses, with its default for DOM-only test environments. */
export function workMotionDuration(element: Element | null) {
	const token =
		element && typeof getComputedStyle !== "undefined"
			? getComputedStyle(element).getPropertyValue("--sc-duration-med").trim()
			: "";
	const duration = Number.parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
	return Number.isFinite(duration) ? duration : 220;
}

const OutgoingFrame = createContext(false);

/** True inside a fading-out layer: its content is a picture of the past and must not publish anything. */
export function useWorkFrameOutgoing() {
	return useContext(OutgoingFrame);
}

interface Frame {
	identity: string;
	children: ReactNode;
}

/**
 * The incoming frame fades in on an opaque surface above the previous one, which fades out
 * underneath and unmounts when its fade ends. A step arriving mid-fade drops the older frame
 * at once: at most two layers ever exist, and none outlives its fade.
 *
 * Both layers keep one element shape keyed by identity, and the outgoing layer is chosen in
 * the same render that changes the identity: the departing frame's DOM stays where it is and
 * only turns outgoing, instead of being torn down and built again for its fade.
 */
export function WorkCrossfade({
	identity,
	motion,
	handoff,
	children,
}: {
	identity: string;
	motion: boolean;
	/** What a previous mount of the same card last showed: the first frame fades in over it. */
	handoff?: Frame | null;
	children: ReactNode;
}) {
	// What the last commit showed: the outgoing layer keeps showing exactly that.
	const committed = useRef<Frame>({ identity, children });
	const [shown, setShown] = useState(identity);
	const [outgoing, setOutgoing] = useState<Frame | null>(null);
	const [handedOff, setHandedOff] = useState(false);
	if (handoff && !handedOff) {
		// Keyed apart from the incoming frame even when both show the same step.
		setHandedOff(true);
		if (motion) setOutgoing({ identity: `${handoff.identity}\u0000handoff`, children: handoff.children });
	}
	if (shown !== identity) {
		setShown(identity);
		setOutgoing(motion ? committed.current : null);
	} else if (!motion && outgoing) setOutgoing(null);
	useLayoutEffect(() => {
		committed.current = { identity, children };
	});
	const element = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!outgoing) return;
		// Fallback for an animation that never reports its end (hidden tab, no CSS). Read after
		// the frame painted: style is clean then, so reading the token costs nothing.
		const timer = setTimeout(() => setOutgoing(null), workMotionDuration(element.current));
		return () => clearTimeout(timer);
	}, [outgoing]);
	const layers =
		outgoing && outgoing.identity !== identity ? [{ identity, children }, outgoing] : [{ identity, children }];
	return (
		<div className="omp-work-crossfade" ref={element} data-motion={motion}>
			{/* First in the DOM for readers and queries; CSS stacks it above the outgoing layer. */}
			{layers.map(layer => {
				const out = layer !== layers[0];
				return (
					<div
						className="omp-work-frame"
						key={layer.identity}
						data-incoming={out ? undefined : true}
						data-outgoing={out ? true : undefined}
						aria-hidden={out || undefined}
						inert={out || undefined}
						onAnimationEnd={
							out
								? event => {
										if (event.target === event.currentTarget) setOutgoing(null);
									}
								: undefined
						}
					>
						<OutgoingFrame.Provider value={out}>{layer.children}</OutgoingFrame.Provider>
					</div>
				);
			})}
		</div>
	);
}
