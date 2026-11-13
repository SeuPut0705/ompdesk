/**
 * The tray against the real shell (PROTOCOL.md §15.3; was the menu cases of `tray-labels.test.ts`): the menu is exactly
 * Open/Hide, one update item that follows the updater, and Quit; choosing the update item asks for the check / download
 * / install its label names; the words follow the language Node pushed. A headless run makes no tray icon and cannot
 * click a native menu, so the cases read the menu the shell would install and press its items with `chrome.menuProbe`.
 * What stays in Rust (`chrome_core::tray`, replayed against `captured/tray.json`): the signature that decides whether
 * the menu is replaced, the hover text, the 30 s "up to date" window, never replacing a menu that is open, and
 * Open/Hide for a visible window (a headless shell has none).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { MAIN_TEXT } from "../../i18n-text";
import { TRAY_LABELS } from "../../tray-labels";
import { chrome, pointChromeAt } from "./chrome";
import { menuProbe } from "./chrome-menu";
import { setTrayState, watchTrayUpdates } from "./chrome-tray";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const updater = vi.hoisted(() => {
	let listener: ((status: unknown) => void) | null = null;
	return {
		status: { state: "idle" } as unknown,
		emit: (status: unknown) => listener?.(status),
		onUpdateStatus: (next: (status: unknown) => void) => {
			listener = next;
			return () => {
				listener = null;
			};
		},
		checkForUpdate: vi.fn(async () => ({ state: "idle" })),
		downloadUpdate: vi.fn(async () => ({ state: "idle" })),
		applyUpdate: vi.fn(async () => undefined),
	};
});

vi.mock("../../updater", () => ({
	onUpdateStatus: updater.onUpdateStatus,
	updateStatus: () => updater.status,
	checkForUpdate: updater.checkForUpdate,
	downloadUpdate: updater.downloadUpdate,
	applyUpdate: updater.applyUpdate,
}));

const exe = testShellExecutable();
const shells: TestShell[] = [];
let current: TestShell | null = null;
pointChromeAt(() => {
	if (!current) throw new Error("no test shell is running");
	return current.client;
});

afterEach(async () => {
	for (const shell of shells.splice(0)) await shell.close();
	vi.clearAllMocks();
});

/** The table Node pushes the shell for a language (`labelTable` of relay.ts, which loads the prefs store). */
function labels(language: "en" | "ko") {
	const text: Record<string, string> = {};
	for (const [key, value] of Object.entries(MAIN_TEXT)) text[key] = value[language];
	for (const [key, value] of Object.entries(TRAY_LABELS)) text[`tray.${key}`] = value[language];
	return { language, text };
}

async function start(language: "en" | "ko" = "en"): Promise<TestShell> {
	const shell = await startTestShell(exe as string, { env: { OMP_GUI_HEADLESS: "1" } });
	shells.push(shell);
	current = shell;
	await shell.client.event("i18n.labels", labels(language));
	return shell;
}

const names = (items: { label: string; type: string }[]) =>
	items.map(item => (item.type === "separator" ? "---" : item.label));

describe.skipIf(!exe)("tray menu", () => {
	it("is Open/Hide, the update item, a separator and Quit, nothing else", async () => {
		await start();
		expect(names(await menuProbe("tray"))).toEqual(["Open OMPdesk", "Check for updates", "---", "Quit"]);
	});

	it("words the update item for each updater state", async () => {
		await start();
		const cases: [UpdateStatus, string, boolean][] = [
			[{ state: "idle" }, "Check for updates", true],
			[{ state: "auth-required", reason: "missing" }, "Check for updates", true],
			[{ state: "checking" }, "Checking for updates…", false],
			[{ state: "available", version: "1.2.3", mode: "automatic" }, "Downloading v1.2.3…", false],
			[{ state: "available", version: "1.2.3", mode: "manual" }, "Download v1.2.3", true],
			[{ state: "downloading", version: "1.2.3", mode: "relaunch", percent: 42 }, "Downloading v1.2.3… 42%", false],
			[{ state: "downloaded", version: "1.2.3", mode: "relaunch" }, "Restart to update to v1.2.3", true],
			[
				{ state: "downloaded", version: "1.2.3", mode: "automatic", restartAt: 5 },
				"Restart to update to v1.2.3",
				true,
			],
			[{ state: "downloaded", version: "1.2.3", mode: "automatic", installing: true }, "Installing v1.2.3…", false],
			[{ state: "not-available", version: "1.0.0" }, "OMPdesk is up to date", false],
			[{ state: "error", message: "x" }, "Update failed — try again", true],
		];
		const stop = watchTrayUpdates();
		for (const [status, label, enabled] of cases) {
			updater.emit(status);
			const items = await menuProbe("tray");
			expect(items[1], status.state).toMatchObject({ label, enabled });
			expect(items.length).toBe(4);
		}
		stop();
	});

	it("speaks Korean when Node pushes it", async () => {
		const shell = await start("ko");
		const stop = watchTrayUpdates();
		updater.emit({ state: "downloaded", version: "1.2.3", mode: "relaunch" });
		expect((await menuProbe("tray"))[1].label).toBe("다시 시작해서 v1.2.3 업데이트");
		await shell.client.event("i18n.labels", labels("en"));
		expect((await menuProbe("tray"))[1].label).toBe("Restart to update to v1.2.3");
		stop();
	});

	it("runs the check, the download or the install its label names, and nothing for a report", async () => {
		await start();
		const stop = watchTrayUpdates();
		const asked: string[] = [];
		const off = chrome().on("updateAction", ({ action }) => asked.push(action));
		const click = async (status: UpdateStatus) => {
			updater.emit(status);
			asked.length = 0;
			await menuProbe("tray", { click: "tray:update" });
			// The click answers when the shell ran it; the event it sent comes after, ahead of the next answer.
			await menuProbe("tray");
			return [...asked];
		};
		expect(await click({ state: "idle" })).toEqual(["check"]);
		expect(await click({ state: "error", message: "x" })).toEqual(["check"]);
		expect(await click({ state: "available", version: "1.2.3", mode: "manual" })).toEqual(["download"]);
		expect(await click({ state: "downloaded", version: "1.2.3", mode: "relaunch" })).toEqual(["apply"]);
		expect(await click({ state: "checking" })).toEqual([]);
		expect(await click({ state: "downloading", version: "1.2.3", mode: "automatic", percent: 1 })).toEqual([]);
		off();
		stop();
	});

	it("turns the shell's update action into the updater's call", async () => {
		await start();
		const stop = watchTrayUpdates();
		await menuProbe("tray", { click: "tray:update" });
		await vi.waitFor(() => expect(updater.checkForUpdate).toHaveBeenCalledOnce());
		updater.emit({ state: "available", version: "1.2.3", mode: "manual" });
		await menuProbe("tray", { click: "tray:update" });
		await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
		updater.emit({ state: "downloaded", version: "1.2.3", mode: "relaunch" });
		await menuProbe("tray", { click: "tray:update" });
		await vi.waitFor(() => expect(updater.applyUpdate).toHaveBeenCalledOnce());
		stop();
	});

	it("takes the renderer's snapshot without changing the menu", async () => {
		await start();
		setTrayState({ status: "streaming", language: "en", projectName: "alpha" });
		expect(names(await menuProbe("tray"))).toEqual(["Open OMPdesk", "Check for updates", "---", "Quit"]);
	});
});
