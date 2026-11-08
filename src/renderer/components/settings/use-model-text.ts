/**
 * A `provider/id` selector as compact text for a sentence or badge that cannot hold a mark: the catalog's short name
 * (`compactModelLabels` over the whole catalog, so look-alikes keep their suffix), else the id's own compact form.
 */

import { useCallback, useMemo } from "react";
import { useModelStore } from "../../stores/model";
import { compactModelLabel, compactModelLabels, compactModelText, modelRefOf } from "./providers/provider-marks";

export function useModelText(): (selector: string) => string {
	const available = useModelStore(state => state.availableModels);
	const labels = useMemo(() => compactModelLabels(available), [available]);
	return useCallback(
		(selector: string) => compactModelText(labels.get(selector) ?? compactModelLabel(modelRefOf(selector))),
		[labels],
	);
}
