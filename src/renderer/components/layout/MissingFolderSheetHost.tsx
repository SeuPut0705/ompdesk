import { Suspense, useEffect, useState } from "react";
import { lazyChunk } from "../../lib/chunk-load";
import { useUiStore } from "../../stores/ui";

const LazyMissingFolderSheet = lazyChunk(() =>
	import("./MissingFolderSheet").then(module => ({ default: module.MissingFolderSheet })),
);

/**
 * Mounts the missing-folder sheet (`useUiStore.missingFolder`, set by `openTab` when main refuses a stored session whose
 * folder is gone) once for the whole window, the phone page included. A chunk of its own, loaded on first open; the last
 * request stays mounted while the sheet animates out.
 */
export function MissingFolderSheetHost() {
	const current = useUiStore(state => state.missingFolder);
	const [shown, setShown] = useState(current);
	useEffect(() => {
		if (current) setShown(current);
	}, [current]);
	const request = current ?? shown;
	if (!request) return null;
	return (
		<Suspense fallback={null}>
			<LazyMissingFolderSheet
				key={`${request.device ?? ""}\n${request.sessionPath}`}
				onClose={() => useUiStore.getState().closeMissingFolder()}
				open={current !== null}
				request={request}
			/>
		</Suspense>
	);
}
