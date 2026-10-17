import { useEffect, useState } from "react";

/** Whole seconds left until `deadline` (epoch ms), ticking each second; null without a deadline. */
export function useSecondsUntil(deadline: number | undefined): number | null {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (deadline === undefined) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [deadline]);
	return deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}
