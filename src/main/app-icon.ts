/**
 * The OMPdesk icon as a file, for the places that take a path instead of the bundle's icon: the window on
 * Windows (and Linux), the About panel's `iconPath` and a Windows toast. macOS draws all three from the
 * bundle (the dev run's Dock icon is set in index.ts). The PNG is `resources/brand/app-icon.png`, generated
 * by `bun run gen:icons` from the mark; packaged apps carry it as `extraResources` (`app-icon.png`).
 */
import { join } from "node:path";
import { app, Notification } from "electron";

export function appIconPath(): string {
	return app.isPackaged
		? join(process.resourcesPath, "app-icon.png")
		: join(__dirname, "..", "..", "resources", "brand", "app-icon.png");
}

/** An OS notification wearing the app icon on Windows (unpackaged runs have no shortcut to take it from). */
export function appNotification(options: Electron.NotificationConstructorOptions): Notification {
	return new Notification(process.platform === "win32" ? { icon: appIconPath(), ...options } : options);
}

/**
 * A test launch (OMP_GUI_HEADLESS) posts no OS notification. Its Electron is node_modules' Electron.app, so macOS
 * filed each one under com.github.Electron and the user's Notification Center showed it with the Electron logo
 * (e2e's "Autopilot ended", "From PC-B"). `show` stays on the prototype, as a no-op, so a spec that wraps
 * `Notification.prototype.show` still sees every notification.
 */
export function holdTestNotifications(): void {
	if (process.env.OMP_GUI_HEADLESS !== "1") return;
	Notification.prototype.show = function show() {};
}
