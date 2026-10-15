import { useEffect } from "react";
import { toast } from "../stores/toast";

/** How long the relaunch toast stays: long enough to notice, and to reach its Stop. */
const NOTICE_MS = 12_000;

/**
 * Turns that continue by themselves (main's turn-resume). This window tells
 * main when the network drops or returns (`online`/`offline`, which only a
 * renderer receives), and the first window to start after a relaunch shows
 * "Continuing N interrupted tasks" with a Stop. Mounted once, by App.
 */
export function useInterruptedWork(): void {
	useEffect(() => {
		const online = () => window.omp.resume.reportOnline(true);
		const offline = () => window.omp.resume.reportOnline(false);
		window.addEventListener("online", online);
		window.addEventListener("offline", offline);
		return () => {
			window.removeEventListener("online", online);
			window.removeEventListener("offline", offline);
		};
	}, []);

	useEffect(() => {
		// Handed out once, so whoever takes it shows it, even when this effect has re-run meanwhile. Main words it
		// in the saved language: the window's own language settles only after it mounts.
		void window.omp.resume.takeNotice().then(notice => {
			if (!notice) return;
			toast({
				variant: "info",
				message: notice.message,
				durationMs: NOTICE_MS,
				action: { label: notice.stop, run: () => void window.omp.resume.stop() },
			});
		});
	}, []);
}
