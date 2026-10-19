/**
 * Order of the sidebar's device sections (this device, `LOCAL_DEVICE`, and each paired host). The user's saved order
 * comes first; a device it does not name (paired since, or never placed) follows in the default order: this device,
 * then the hosts as the remote store lists them. Ids the saved order names that are not present are ignored here and
 * pruned by `useSidebarFolds.syncHosts` once the host list has loaded.
 */
import { reorderProjects } from "./project-order";

export function orderDevices(present: readonly string[], saved: readonly string[]): string[] {
	const placed = [...new Set(saved.filter(id => present.includes(id)))];
	return [...placed, ...present.filter(id => !placed.includes(id))];
}

/** `order` with `id` moved `delta` places (−1 up, +1 down); unchanged at an edge or for an unknown id. */
export function moveDevice(order: readonly string[], id: string, delta: number): string[] {
	const target = order[order.indexOf(id) + delta];
	return target === undefined || !order.includes(id) ? [...order] : reorderProjects(order, id, target);
}
