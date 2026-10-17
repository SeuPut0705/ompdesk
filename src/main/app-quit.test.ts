/**
 * The quit prompt (app-quit.ts): with Continue interrupted work off, ⌘Q while a turn runs asks before stopping it;
 * "Quit anyway" quits, "Keep working" (the default and the cancel) does not, and ⌘Q again while it asks queues
 * nothing. With the setting on, nothing asks.
 */
import type { MessageBoxOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmQuit, installQuitGuard, setQuitResumes } from "./app-quit";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";

const electron = vi.hoisted(() => {
	const beforeQuit: Array<(event: { preventDefault(): void }) => void> = [];
	return {
		beforeQuit,
		quit: vi.fn(),
		showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<{ response: number }>>(),
	};
});

vi.mock("electron", () => ({
	app: {
		on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
			if (name === "before-quit") electron.beforeQuit.push(listener);
		},
		quit: electron.quit,
	},
	autoUpdater: { on: () => {} },
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: electron.showMessageBox },
}));
// The real ./i18n opens the prefs store at load; the text table is what matters here.
vi.mock("./i18n", () => ({
	getMainLanguage: () => "en",
	mainT: (key: MainTextKey, _language: string, params: Record<string, number> = {}) =>
		MAIN_TEXT[key].en.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name])),
}));

let working = true;
installQuitGuard(
	() => [
		{ windowId: 1, tabId: "a", inFlight: working },
		{ windowId: 1, tabId: "b", inFlight: false },
	],
	() => {},
	async () => {},
);

beforeEach(() => {
	working = true;
	setQuitResumes(() => false);
	electron.showMessageBox.mockReset();
	electron.quit.mockReset();
});

describe("confirmQuit", () => {
	it("asks while a turn runs and the setting is off, and only 'Quit anyway' quits", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		expect(await confirmQuit()).toBe(true);
		expect(electron.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
			type: "warning",
			buttons: ["Quit anyway", "Keep working"],
			defaultId: 1,
			cancelId: 1,
			message: "Sessions are still running",
			detail: "1 of 2 sessions are still working in 1 window(s). Quitting stops them and their agents.",
		});
		electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
		expect(await confirmQuit()).toBe(false);
	});

	it("asks nothing when no turn runs, or when the running turns continue after the next launch", async () => {
		working = false;
		expect(await confirmQuit()).toBe(true);
		working = true;
		setQuitResumes(() => true);
		expect(await confirmQuit()).toBe(true);
		expect(electron.showMessageBox).not.toHaveBeenCalled();
	});

	it("a second quit while the prompt is open queues no second prompt", async () => {
		const answer = Promise.withResolvers<{ response: number }>();
		electron.showMessageBox.mockReturnValueOnce(answer.promise);
		const first = confirmQuit();
		expect(await confirmQuit()).toBe(false);
		answer.resolve({ response: 1 });
		expect(await first).toBe(false);
		expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("⌘Q goes through the prompt: the quit is held, and 'Quit anyway' quits", async () => {
		electron.showMessageBox.mockResolvedValueOnce({ response: 0 });
		const preventDefault = vi.fn();
		for (const listener of electron.beforeQuit) listener({ preventDefault });
		expect(preventDefault).toHaveBeenCalled();
		await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(1));
	});
});
