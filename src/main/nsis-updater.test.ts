/**
 * Windows' install (nsis-updater.ts): the installer starts off the main thread, and the app quits only once it
 * runs. A quit before that would end the process while the installer was still being started.
 */

import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpNsisUpdater } from "./nsis-updater";

const mocks = vi.hoisted(() => ({
	order: [] as string[],
	start: vi.fn<(command: string, args: readonly string[]) => Promise<number>>(),
}));

vi.mock("electron", () => ({ autoUpdater: { emit: (event: string) => mocks.order.push(event) } }));
vi.mock("./installer-spawn", () => ({ spawnDetachedOffThread: mocks.start }));

const app = {
	version: "0.44.0",
	name: "OMPdesk",
	isPackaged: true,
	appUpdateConfigPath: "",
	userDataPath: "",
	baseCachePath: "",
	whenReady: async () => {},
	relaunch: () => {},
	quit: () => mocks.order.push("app.quit"),
	onQuit: () => {},
};

/** An updater whose installer has been downloaded and verified, as `update-downloaded` leaves it. */
async function downloaded(installer: string): Promise<OmpNsisUpdater> {
	class Downloaded extends OmpNsisUpdater {
		async keep(file: string): Promise<void> {
			this.downloadedUpdateHelper = new DownloadedUpdateHelper("unused");
			await this.downloadedUpdateHelper.setDownloadedFile(
				file,
				null,
				{ version: "0.45.0", files: [], path: "setup.exe", sha512: "x", releaseDate: "2026-10-20" },
				{ url: new URL("https://example.invalid/setup.exe"), info: { url: "setup.exe", sha512: "x" } },
				"setup.exe",
				false,
			);
		}
	}
	const updater = new Downloaded(undefined, app);
	await updater.keep(installer);
	return updater;
}

afterEach(() => {
	mocks.order.length = 0;
	mocks.start.mockReset();
});

describe("OmpNsisUpdater.quitAndInstall", () => {
	it("starts the installer without waiting for it, and quits only once it is running", async () => {
		const started = Promise.withResolvers<number>();
		mocks.start.mockReturnValue(started.promise);
		const updater = await downloaded("C:\\updates\\ompdesk-windows-setup.exe");

		updater.quitAndInstall();

		expect(mocks.start).toHaveBeenCalledWith(
			"C:\\updates\\ompdesk-windows-setup.exe",
			expect.arrayContaining(["--updated"]),
		);
		expect(mocks.order).toEqual([]);
		started.resolve(4242);
		await vi.waitFor(() => expect(mocks.order).toEqual(["before-quit-for-update", "app.quit"]));
	});

	it("still quits when the installer could not start, and the updater reports why", async () => {
		mocks.start.mockRejectedValue(Object.assign(new Error("the installer would not start"), { code: "EPERM" }));
		const updater = await downloaded("C:\\updates\\ompdesk-windows-setup.exe");
		const failures: unknown[] = [];
		updater.on("error", error => failures.push(error));

		updater.quitAndInstall();

		await vi.waitFor(() => expect(mocks.order).toEqual(["before-quit-for-update", "app.quit"]));
		expect(failures).toMatchObject([{ code: "EPERM" }]);
	});

	it("starts nothing and does not quit when there is no downloaded installer", () => {
		const updater = new OmpNsisUpdater(undefined, app);
		const failures: unknown[] = [];
		updater.on("error", error => failures.push(error));

		updater.quitAndInstall();

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.order).toEqual([]);
		expect(failures).toHaveLength(1);
	});

	it("an install at app quit stays on the calling thread: the process may end right after it", async () => {
		const updater = await downloaded(process.execPath);

		updater.install(true, false);

		expect(mocks.start).not.toHaveBeenCalled();
	});
});
