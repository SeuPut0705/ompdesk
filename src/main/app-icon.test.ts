import { Notification } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appNotification, holdTestNotifications } from "./app-icon";

// What reached the OS: the fake Notification below records each real `show`.
const os = vi.hoisted(() => ({ posted: [] as string[] }));

vi.mock("electron", () => {
	class Notification {
		constructor(readonly options: { title: string; icon?: string }) {}
		get title(): string {
			return this.options.title;
		}
		show(): void {
			os.posted.push(this.options.title);
		}
	}
	return { app: { isPackaged: false }, Notification };
});

const realShow = Notification.prototype.show;

describe("notifications of a test launch", () => {
	afterEach(() => {
		Notification.prototype.show = realShow;
		os.posted.length = 0;
		vi.unstubAllEnvs();
	});

	// macOS files an unpackaged run's notification under node_modules' Electron.app (com.github.Electron), so
	// it reached the user's Notification Center wearing the Electron logo: "Autopilot ended" from
	// autopilot-cycles.e2e.ts and "From PC-B" from agent-control-across.e2e.ts, read from this Mac's
	// usernoted database on 21 Oct 2026.
	it("posts nothing to the OS (OMP_GUI_HEADLESS)", () => {
		vi.stubEnv("OMP_GUI_HEADLESS", "1");
		holdTestNotifications();
		appNotification({ title: "Autopilot ended" }).show();
		expect(os.posted).toEqual([]);
	});

	it("still lets a spec see each notification through Notification.prototype.show", () => {
		vi.stubEnv("OMP_GUI_HEADLESS", "1");
		holdTestNotifications();
		const seen: string[] = [];
		const held = Notification.prototype.show;
		Notification.prototype.show = function (this: Electron.Notification) {
			seen.push(this.title);
			return held.call(this);
		};
		appNotification({ title: "From PC-B" }).show();
		expect(seen).toEqual(["From PC-B"]);
		expect(os.posted).toEqual([]);
	});

	it("leaves a launch that is no test alone", () => {
		vi.stubEnv("OMP_GUI_HEADLESS", "");
		holdTestNotifications();
		appNotification({ title: "Done" }).show();
		expect(os.posted).toEqual(["Done"]);
	});
});
