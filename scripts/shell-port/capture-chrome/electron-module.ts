/**
 * What `import … from "electron"` gives the code under capture: each member forwards to the shim of the fake shell an
 * area made current (`use`), so one capture process can run several fake shells (platforms, fresh state) in turn.
 */
import type { ElectronShim } from "../../../src/main/shell-host/electron/create";

let shim: ElectronShim | null = null;

export function use(next: ElectronShim): void {
	shim = next;
}

function member(name: string): unknown {
	if (!shim) throw new Error(`electron.${name} used before a fake shell was made current`);
	return (shim as unknown as Record<string, unknown>)[name];
}

const MEMBERS = [
	"app",
	"autoUpdater",
	"BrowserWindow",
	"WebContentsView",
	"Notification",
	"nativeImage",
	"nativeTheme",
	"screen",
	"shell",
	"dialog",
	"clipboard",
	"ipcMain",
	"powerMonitor",
	"powerSaveBlocker",
	"globalShortcut",
	"protocol",
	"session",
	"net",
	"safeStorage",
	"systemPreferences",
	"webContents",
	"shellHost",
];

/** The module's exports: a forwarding proxy per member (functions and classes stay callable and constructible). */
export function current(): Record<string, unknown> {
	const exports: Record<string, unknown> = {};
	for (const name of MEMBERS) {
		exports[name] = new Proxy(function forward() {}, {
			get: (_target, key) => {
				const value = member(name) as Record<PropertyKey, unknown>;
				const field = value[key];
				return typeof field === "function" ? field.bind(value) : field;
			},
			set: (_target, key, value) => {
				(member(name) as Record<PropertyKey, unknown>)[key] = value;
				return true;
			},
			apply: (_target, self, args) => (member(name) as (...a: unknown[]) => unknown).apply(self, args),
			construct: (_target, args) => new (member(name) as new (...a: unknown[]) => object)(...args),
		});
	}
	// electron-store reads `import electron from "electron"`.
	return { ...exports, default: { ...exports } };
}
