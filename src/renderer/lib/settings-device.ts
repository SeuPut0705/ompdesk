/**
 * Which device's settings the Settings page shows. There is no setting of its own: Settings, Usage and Stats follow
 * the focused tab's device (stores/remote.ts `useFocusedHost`, components/remote/HostScope.tsx), so showing another
 * device's settings means focusing a tab that runs on it. The device pills at the top of Settings do exactly that and
 * nothing else, through the tab store's own `switchTab` and `openTab`.
 */
import { focusedTabDevice } from "../stores/remote";
import { type SessionTab, useTabsStore } from "../stores/tabs";

/** The id of this computer's pill; a paired host's is its `deviceId`. */
export const LOCAL_DEVICE = "local";

/** The tab each device had focused when the person last left it, so coming back lands where they were. */
const lastFocused = new Map<string, string>();

const keyOf = (device: string | undefined): string => device ?? LOCAL_DEVICE;

function tabOn(tabs: readonly SessionTab[], device: string | undefined): SessionTab | undefined {
	const mine = tabs.filter(tab => tab.device === device && !tab.ghost);
	const kept = lastFocused.get(keyOf(device));
	return mine.find(tab => tab.id === kept) ?? mine[0];
}

/**
 * Focus a tab on `device` (undefined = this computer): the one the person left there, else the first, else a new chat
 * tab in that device's own default workspace (a device with no tab open has none to focus, and a chat tab starts no
 * project). The Settings page stays open; only what its scope follows changes.
 */
export async function showSettingsOf(device: string | undefined): Promise<void> {
	if (focusedTabDevice() === device) return;
	const { tabs, activeTabId } = useTabsStore.getState();
	if (activeTabId) lastFocused.set(keyOf(focusedTabDevice()), activeTabId);
	const target = tabOn(tabs, device);
	if (target) {
		await useTabsStore.getState().switchTab(target.id);
		return;
	}
	await useTabsStore.getState().openTab({ kind: "chat", ...(device === undefined ? {} : { device }) });
}
