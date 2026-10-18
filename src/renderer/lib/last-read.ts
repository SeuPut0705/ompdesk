/**
 * The last read of a panel or page (Stats, ai-memory): the page paints it at its first frame and reads again in
 * place, instead of opening on a wait. Two layers over `lib/snapshot-cache.ts` (kind `panel`): memory for the
 * rest of this run (any size, never scrubbed because it never leaves the page) and the snapshot for the next run
 * (scrubbed, bounded). `persist: false` keeps a read in memory only.
 */
import { snapshotNs, snapshots } from "./snapshot-cache";

const memory = new Map<string, unknown>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const WRITE_DELAY_MS = 2000;

const slot = (device: string | undefined, key: string) => `${snapshotNs(device)}\u0000${key}`;

export function lastRead<T>(device: string | undefined, key: string): T | undefined {
	const id = slot(device, key);
	if (memory.has(id)) return memory.get(id) as T;
	const hit = snapshots().read<T>("panel", snapshotNs(device), key);
	if (hit === null) return undefined;
	memory.set(id, hit.value);
	return hit.value;
}

export function rememberRead<T>(device: string | undefined, key: string, value: T, persist = true): void {
	const id = slot(device, key);
	memory.set(id, value);
	if (!persist) return;
	clearTimeout(timers.get(id));
	timers.set(
		id,
		setTimeout(() => {
			timers.delete(id);
			snapshots().write("panel", snapshotNs(device), key, memory.get(id));
		}, WRITE_DELAY_MS),
	);
}

/** Tests: forget the memory layer. */
export function resetLastReadForTest(): void {
	memory.clear();
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
}
