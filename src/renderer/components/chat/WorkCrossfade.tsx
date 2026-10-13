import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";

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

/**
 * The incoming frame fades in on an opaque surface above the previous one, which fades out
 * underneath and unmounts when its fade ends. A step arriving mid-fade drops the older frame
 * at once: at most two layers ever exist, and none outlives its fade.
 */
export function WorkCrossfade({
	identity,
	motion,
	children,
}: {
	identity: string;
	motion: boolean;
	children: ReactNode;
}) {
	const frame = useRef({ identity, children });
	const [outgoing, setOutgoing] = useState<{ identity: string; children: ReactNode } | null>(null);
	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (frame.current.identity !== identity && motion) setOutgoing(frame.current);
		else if (!motion) setOutgoing(null);
		frame.current = { identity, children };
	}, [identity, motion, children]);
	useLayoutEffect(() => {
		if (!outgoing) return;
		// Fallback for an animation that never reports its end (hidden tab, no CSS).
		const timer = setTimeout(() => setOutgoing(null), workMotionDuration(element.current));
		return () => clearTimeout(timer);
	}, [outgoing]);
	return (
		<div className="omp-work-crossfade" ref={element} data-motion={motion}>
			{/* First in the DOM for readers and queries; CSS stacks it above the outgoing layer. */}
			<div className="omp-work-frame" key={identity} data-incoming>
				{children}
			</div>
			{outgoing ? (
				<div
					className="omp-work-frame"
					key={`out:${outgoing.identity}`}
					data-outgoing
					aria-hidden
					inert
					onAnimationEnd={event => {
						if (event.target === event.currentTarget) setOutgoing(null);
					}}
				>
					<OutgoingFrame.Provider value>{outgoing.children}</OutgoingFrame.Provider>
				</div>
			) : null}
		</div>
	);
}
