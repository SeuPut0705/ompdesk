import { Suspense, useEffect, useState } from "react";
import { lazyChunk } from "../../lib/chunk-load";
import { SessionRuntimeProvider, useTabSessionRuntime } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";

const LazyViewSheet = lazyChunk(() => import("./ViewSheets").then(module => ({ default: module.ViewSheet })));

/**
 * Mounts the open view sheet (`useUiStore.viewSheet`) inside the runtime of the tab it opened on, so the view reads
 * that tab's session (a paired host's tab: the host's) exactly as the side panel did, whatever the focus does next.
 * The last sheet stays mounted while it animates out.
 */
export function ViewSheetHost() {
	const current = useUiStore(state => state.viewSheet);
	const [shown, setShown] = useState(current);
	useEffect(() => {
		if (current) setShown(current);
	}, [current]);
	const sheet = current ?? shown;
	const runtime = useTabSessionRuntime(sheet?.tabId ?? null);
	if (!sheet) return null;
	const view = (
		<Suspense fallback={null}>
			<LazyViewSheet
				onClose={() => useUiStore.getState().closeViewSheet()}
				open={current !== null}
				view={sheet.view}
			/>
		</Suspense>
	);
	return runtime ? <SessionRuntimeProvider runtime={runtime}>{view}</SessionRuntimeProvider> : view;
}
