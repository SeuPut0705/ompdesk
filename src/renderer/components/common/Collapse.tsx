import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { motionPlay } from "../../lib/motion";

/**
 * The body of a disclosure that opens and closes with its height (`lib/motion-play.ts` `animateHeight`): the content
 * mounts when `open` turns true and grows in from nothing, and stays mounted while it shrinks away after `open` turns
 * false, inert and hidden from assistive tech, then unmounts. A body that is open on its first render shows at once,
 * and so does every change where motion is off or the body is taller than the window.
 *
 * The wrapper is a plain block with no style of its own at rest, so the content lays out as it would without it.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
	const [closing, setClosing] = useState(false);
	const [wasOpen, setWasOpen] = useState(open);
	const ref = useRef<HTMLDivElement>(null);
	const animation = useRef<Animation | null>(null);
	const first = useRef(true);
	if (open !== wasOpen) {
		setWasOpen(open);
		setClosing(!open);
	}
	useLayoutEffect(() => {
		const element = ref.current;
		if (first.current) {
			first.current = false;
			return;
		}
		if (!element) return;
		// Pick up from wherever a running open or close left the height.
		const from = animation.current ? element.getBoundingClientRect().height : open ? 0 : element.scrollHeight;
		animation.current?.cancel();
		const to = open ? element.scrollHeight : 0;
		const running = motionPlay()?.animateHeight(element, from, to) ?? null;
		animation.current = running;
		if (!running) {
			if (!open) setClosing(false);
			return;
		}
		running.onfinish = () => {
			if (animation.current !== running) return;
			animation.current = null;
			if (!open) setClosing(false);
		};
	}, [open]);

	if (!open && !closing) return null;
	return (
		<div aria-hidden={closing || undefined} className={className} data-collapse="" inert={closing} ref={ref}>
			{children}
		</div>
	);
}
