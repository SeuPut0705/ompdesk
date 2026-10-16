import { useEffect, useRef } from "react";
import { pushBackLayer } from "../lib/back-layer";

/** While `open`, the system back gesture calls `onClose` (web shell only; see lib/back-layer.ts). */
export function useBackLayer(open: boolean, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		if (!open) return;
		return pushBackLayer(() => onCloseRef.current());
	}, [open]);
}
