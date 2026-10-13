import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Read the same token CSS uses, with its default for DOM-only test environments. */
export function workMotionDuration(element: Element | null) {
	const token =
		element && typeof getComputedStyle !== "undefined"
			? getComputedStyle(element).getPropertyValue("--sc-duration-med").trim()
			: "";
	const duration = Number.parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
	return Number.isFinite(duration) ? duration : 220;
}

/** Keep the previous frame inert while its replacement fades in, never clearing the stage. */
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
	const [outgoing, setOutgoing] = useState<ReactNode>(null);
	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (frame.current.identity !== identity && motion) setOutgoing(frame.current.children);
		else if (!motion) setOutgoing(null);
		frame.current = { identity, children };
	}, [identity, motion, children]);
	useLayoutEffect(() => {
		if (!outgoing) return;
		const timer = setTimeout(() => setOutgoing(null), workMotionDuration(element.current));
		return () => clearTimeout(timer);
	}, [outgoing]);
	return (
		<div className="omp-work-crossfade" ref={element} data-motion={motion}>
			<div className="omp-work-frame" key={identity} data-incoming>
				{children}
			</div>
			{outgoing ? (
				<div className="omp-work-frame" data-outgoing aria-hidden inert>
					{outgoing}
				</div>
			) : null}
		</div>
	);
}
