/**
 * Text that eases in when it changes while mounted (an automatic session title evolving). `scope` names what the
 * text belongs to (a session); a new scope is a different thing, not a change, so it paints without motion.
 * The animation itself is `.omp-title-swap` (styles/components.css), shortened to nothing by the global
 * prefers-reduced-motion rule.
 */
import { useRef } from "react";
import { cx } from "../../lib/format";

interface SwapTextProps {
	children: string;
	scope: string;
	className?: string;
}

export function SwapText({ children, scope, className }: SwapTextProps) {
	const seen = useRef({ scope, text: children, swaps: 0 });
	if (seen.current.scope !== scope) seen.current = { scope, text: children, swaps: 0 };
	else if (seen.current.text !== children) {
		seen.current = { scope, text: children, swaps: seen.current.swaps + 1 };
	}
	const { swaps } = seen.current;
	return (
		// A new key restarts the animation for each change.
		<span className={cx("omp-title-swap", className)} data-title-swap={swaps > 0 ? "" : undefined} key={swaps}>
			{children}
		</span>
	);
}
