import { useEffect } from "react";

/**
 * Turns that continue by themselves (main's turn-resume). This window tells main when the network drops or
 * returns (`online`/`offline`, which only a renderer receives). The relaunch itself says nothing here: each
 * resuming tab shows its own calm row (ChatStream's TurnStatusRow). Mounted once, by App.
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
}
