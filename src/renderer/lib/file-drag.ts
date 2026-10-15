/**
 * A Files tree row dragged onto the composer (C42): the row puts
 * `{ path, tabId }` under this type, and the composer turns the drop into an
 * @mention through the same `omp:insert-mention` event the tree's menu uses.
 */
export const FILE_DRAG_TYPE = "application/x-ompdesk-file";

/** The dragged row's path and tab, or null when the payload is not ours. */
export function readFileDrag(data: DataTransfer): { path: string; tabId: string | null } | null {
	try {
		const value: unknown = JSON.parse(data.getData(FILE_DRAG_TYPE));
		if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") return null;
		const tabId = "tabId" in value && typeof value.tabId === "string" ? value.tabId : null;
		return value.path ? { path: value.path, tabId } : null;
	} catch {
		return null;
	}
}
