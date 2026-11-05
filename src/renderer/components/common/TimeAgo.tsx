import { formatClock } from "../../lib/format";
import { useShortAge } from "../../lib/now-tick";

/**
 * A session row's age ("8m", "3h", "3w"; never a date: the owner's call of 6 Nov 2026), moving on as time passes while
 * the window is in view; the exact date and time are its title.
 */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
	const label = useShortAge(iso);
	return (
		<time className={className} dateTime={iso} title={formatClock(iso)}>
			{label}
		</time>
	);
}
