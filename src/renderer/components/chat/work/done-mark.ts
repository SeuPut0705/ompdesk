/** Cards whose finish already played the done mark, oldest first (a card key plays it once, however it remounts). */
const played = new Set<string>();
const REMEMBERED = 512;

/** True the first time a card key asks: the caller then plays the one-shot `.omp-done-pop` on its head mark. */
export function claimDoneMark(key: string): boolean {
	if (played.has(key)) return false;
	played.add(key);
	if (played.size > REMEMBERED) {
		const [oldest] = played;
		if (oldest !== undefined) played.delete(oldest);
	}
	return true;
}
