import { Suspense } from "react";
import { lazyChunk } from "../../lib/chunk-load";

// Its own chunk: the eager tool renderers show it only after a failed step, and the paired phone's first screen stays
// inside its JavaScript budget (scripts/check-main-bundle.ts).
const Fix = lazyChunk(() => import("./MacPermissionFix").then(module => ({ default: module.MacPermissionFix })));

/** `MacPermissionFix` for the renderers in the first screen's bundle (`ComputerRenderer`, `EvalRenderer`). */
export function LazyMacPermissionFix() {
	return (
		<Suspense fallback={null}>
			<Fix />
		</Suspense>
	);
}
