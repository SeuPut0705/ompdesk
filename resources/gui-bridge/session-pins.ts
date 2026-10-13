/**
 * Session pins in omp's pins file (stock session/session-pins.ts).
 *
 * Kept instead of stock `toggleSessionPin`, which flips the stored state: the GUI
 * asks for a state, and assigning it is retry-safe, while load-then-toggle is two
 * steps that race another process. The write is stock's: the same cross-process
 * lock, a 0600 temp file and `replaceFileAtomically`. src/main/bridge-session-pins.test.ts
 * pins it to stock's file format and lock.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadPinnedSessionIds } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { getAgentDir, withFileLock } from "@oh-my-pi/pi-utils";

/** omp's pins file: a JSON array of session ids. */
const PINS_FILENAME = "session-pins.json";

/** Pin (`pinned`) or unpin `sessionId`; a no-op when it already is. */
export async function setSessionPinned(
	sessionId: string,
	pinned: boolean,
	agentDir: string = getAgentDir(),
): Promise<boolean> {
	const filePath = path.join(agentDir, PINS_FILENAME);
	await fs.mkdir(agentDir, { recursive: true });
	return withFileLock(filePath, async () => {
		const pins = await loadPinnedSessionIds(agentDir);
		if (pins.has(sessionId) === pinned) return pinned;
		if (pinned) pins.add(sessionId);
		else pins.delete(sessionId);
		const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify([...pins], null, "\t"), { encoding: "utf-8", mode: 0o600 });
			await replaceFileAtomically(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		return pinned;
	});
}
