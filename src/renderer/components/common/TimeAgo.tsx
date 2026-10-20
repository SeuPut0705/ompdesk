import { useTimeAgo } from "../../lib/now-tick";

/** A row's age ("8m", "3h"), moving on as time passes while the window is in view (`useTimeAgo`). */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
	const label = useTimeAgo(iso);
	return (
		<time className={className} dateTime={iso}>
			{label}
		</time>
	);
}
