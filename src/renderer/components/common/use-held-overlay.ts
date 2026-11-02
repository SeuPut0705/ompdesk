import { useRef } from "react";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import type { MotionDuration } from "../../lib/motion";

/**
 * `useOverlayPresence` for an overlay whose content is its own data (`value` is `null` while it is closed: a
 * completion menu, a paste choice). `shown` is the value to draw: the live one, or while the overlay plays its exit
 * the last one, so the surface leaves with its content and does not collapse to an empty box; `null` once gone.
 * `exit` names the token the exit class lasts.
 */
export function useHeldOverlay<T>(
	value: T | null,
	exit: MotionDuration = "fast",
): { shown: T | null; closing: boolean } {
	const last = useRef(value);
	if (value !== null) last.current = value;
	const { mounted, closing } = useOverlayPresence(value !== null, exit);
	return { shown: mounted ? last.current : null, closing };
}
