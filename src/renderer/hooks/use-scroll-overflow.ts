import { type RefObject, useLayoutEffect, useState } from "react";

export interface ScrollOverflow {
	x: boolean;
	y: boolean;
}

/**
 * Whether an element's content runs past its box, across and down, kept current as it or its content resizes.
 * A scroller that overflows is reachable by keyboard only when it takes focus (WCAG 2.1.1; axe's
 * scrollable-region-focusable): this tells a component when to give it a tab stop, so a short block adds none.
 */
/** `content` changes whenever what the element shows does (a scroll width moves without the box resizing). */
export function useScrollOverflow(ref: RefObject<HTMLElement | null>, content: unknown): ScrollOverflow {
	const [overflow, setOverflow] = useState<ScrollOverflow>({ x: false, y: false });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `content` is what moves the scroll size, not read here.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const x = element.scrollWidth > element.clientWidth + 1;
			const y = element.scrollHeight > element.clientHeight + 1;
			setOverflow(previous => (previous.x === x && previous.y === y ? previous : { x, y }));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of Array.from(element.children)) observer.observe(child);
		return () => observer.disconnect();
	}, [ref, content]);
	return overflow;
}
