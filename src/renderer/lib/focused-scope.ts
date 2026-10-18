/**
 * Whose data a panel shows: the focused tab's host (`device`, undefined = this computer) and project folder
 * (`cwd`). It is the key of every last-read panel snapshot (`lib/last-read.ts`), so a repository's list never
 * paints as another repository's, nor a paired host's as this computer's.
 */
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

export interface FocusedScope {
	device: string | undefined;
	cwd: string;
}

export function useFocusedScope(): FocusedScope & { id: string } {
	const tabId = useRuntimeTabId();
	const device = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.device);
	const cwd = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.cwd ?? "");
	return { device, cwd, id: `${device ?? ""}\u0000${cwd}` };
}
