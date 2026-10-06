import { useEffect, useState } from "react";
import { acceptsActiveTabEvents, onActiveTabRouteState } from "../lib/tab-routing";

/** True only when renderer selection and main-process sidecar routing agree. */
export function useActiveTabRouteReady(): boolean {
	const [ready, setReady] = useState(acceptsActiveTabEvents);
	useEffect(() => {
		setReady(acceptsActiveTabEvents());
		return onActiveTabRouteState(setReady);
	}, []);
	return ready;
}
