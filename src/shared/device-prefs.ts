/**
 * Which preferences a paired web device (phone, tablet) keeps for itself. The host stores them in the device's
 * own `uiPrefs` record (`web:device.uiPrefs.get/set`, src/main/web/devices-store.ts) instead of its prefs
 * store, so a theme chosen on the phone never reaches the desktop and the desktop's never reaches the phone.
 *
 * Appearance and layout are device-local. Agent behaviour, models, accounts, notification policy, the
 * keyboard map and every other key stay the host's. The web page's shim (src/renderer/web/shim.ts) routes by
 * `isDeviceLocalPref`; the desktop window never calls it.
 */

/** Exact keys (dotted paths as `prefs.set` takes them). */
export const DEVICE_LOCAL_PREF_KEYS: readonly string[] = [
	// Theme.
	"theme",
	"themeName",
	"systemLightTheme",
	"systemDarkTheme",
	"followAgentTheme",
	"colorBlindMode",
	// Type and density.
	"fontSize",
	"compactDensity",
	// How a conversation renders.
	"transcriptDetail",
	"thinkingExpanded",
	"codeLineNumbers",
	// Layout.
	"sidebarWidth",
	"sidebarVisible",
	"sidebarFolds",
	"sidebarFamilies",
	"gui.panelWidth",
	"panelSide",
	"defaultPanelTab",
];

/** `displayPreferences.<field>`: the transcript display switches and the paste threshold. */
const DISPLAY_PREFERENCES = "displayPreferences";

export function isDeviceLocalPref(key: string): boolean {
	return (
		DEVICE_LOCAL_PREF_KEYS.includes(key) || key === DISPLAY_PREFERENCES || key.startsWith(`${DISPLAY_PREFERENCES}.`)
	);
}

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setPath(tree: Tree, path: string, value: unknown): void {
	const parts = path.split(".");
	let node = tree;
	for (const part of parts.slice(0, -1)) {
		const next = node[part];
		if (isTree(next)) node = next;
		else {
			const made: Tree = {};
			node[part] = made;
			node = made;
		}
	}
	node[parts[parts.length - 1] as string] = value;
}

function deletePath(tree: Tree, path: string): void {
	const parts = path.split(".");
	let node = tree;
	for (const part of parts.slice(0, -1)) {
		const next = node[part];
		if (!isTree(next)) return;
		const copy = { ...next };
		node[part] = copy;
		node = copy;
	}
	delete node[parts[parts.length - 1] as string];
}

/** The device's flat `{ "gui.panelWidth": 420 }` record as the nested object the host's store would hold. */
export function nestDevicePrefs(device: Readonly<Tree>): Tree {
	const nested: Tree = {};
	for (const [key, value] of Object.entries(device)) if (isDeviceLocalPref(key)) setPath(nested, key, value);
	return nested;
}

/**
 * The page's whole prefs object: the host's, minus every device-local key (the host's own appearance is not
 * this device's), plus the device's.
 */
export function overlayDevicePrefs(host: unknown, device: Readonly<Tree>): Tree {
	const merged: Tree = isTree(host) ? { ...host } : {};
	for (const key of DEVICE_LOCAL_PREF_KEYS) deletePath(merged, key);
	delete merged[DISPLAY_PREFERENCES];
	for (const [key, value] of Object.entries(device)) if (isDeviceLocalPref(key)) setPath(merged, key, value);
	return merged;
}

/** One device-local key read from the device's record (`displayPreferences` gives the nested object). */
export function readDevicePref(device: Readonly<Tree>, key: string): unknown {
	let node: unknown = nestDevicePrefs(device);
	for (const part of key.split(".")) {
		if (!isTree(node)) return undefined;
		node = node[part];
	}
	return node;
}
