/**
 * Contracts for the tray's pure layer: the menu is exactly Open/Hide, one update
 * item that follows the updater, and Quit; clicking the update item runs the
 * check / download / install it names; the rebuild signature ignores what a user
 * cannot read.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrayState, UpdateStatus } from "../shared/ipc-types";
import {
	aggregateProgress,
	aggregateTrayStatus,
	menuSignature,
	statusLabel,
	type TrayMenuActions,
	trayMenuTemplate,
	trayTooltip,
	trayUpdateItem,
} from "./tray-labels";

function state(overrides: Partial<TrayState> = {}): TrayState {
	return { status: "idle", language: "en", projectName: "alpha", ...overrides };
}

function menu(update: UpdateStatus, options: { upToDateShown?: boolean; windowVisible?: boolean } = {}) {
	const actions: TrayMenuActions = { toggleWindow: vi.fn(), update: vi.fn(), quit: vi.fn() };
	const template = trayMenuTemplate(
		{
			lang: "en",
			windowVisible: options.windowVisible ?? true,
			update: trayUpdateItem("en", update, options.upToDateShown ?? true),
		},
		actions,
	);
	return { template, actions };
}

const items = (template: ReturnType<typeof menu>["template"]) =>
	template.map(item => (item.type === "separator" ? "---" : item.label));

describe("tray menu", () => {
	it("is Open/Hide, the update item, a separator and Quit, nothing else", () => {
		expect(items(menu({ state: "idle" }).template)).toEqual(["Hide OMPdesk", "Check for updates", "---", "Quit"]);
		expect(items(menu({ state: "idle" }, { windowVisible: false }).template)[0]).toBe("Open OMPdesk");
	});

	it("words the update item for each updater state", () => {
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
		for (const [status, label, enabled] of cases) {
			const { template } = menu(status);
			expect(template[1], status.state).toMatchObject({ label, enabled });
			expect(items(template).length).toBe(4);
		}
	});

	it("offers a check again once the up-to-date notice has run out", () => {
		const { template } = menu({ state: "not-available", version: "1.0.0" }, { upToDateShown: false });
		expect(template[1]).toMatchObject({ label: "Check for updates", enabled: true });
	});

	it("speaks Korean when the renderer reports it", () => {
		expect(trayUpdateItem("ko", { state: "downloaded", version: "1.2.3", mode: "relaunch" }, true).label).toBe(
			"다시 시작해서 v1.2.3 업데이트",
		);
	});

	it("runs the check, the download or the install its label names, and nothing for a report", () => {
		const click = (status: UpdateStatus) => {
			const { template, actions } = menu(status);
			(template[1].click as () => void)();
			return vi.mocked(actions.update).mock.calls.map(([action]) => action);
		};
		expect(click({ state: "idle" })).toEqual(["check"]);
		expect(click({ state: "error", message: "x" })).toEqual(["check"]);
		expect(click({ state: "available", version: "1.2.3", mode: "manual" })).toEqual(["download"]);
		expect(click({ state: "downloaded", version: "1.2.3", mode: "relaunch" })).toEqual(["install"]);
		expect(click({ state: "checking" })).toEqual([]);
		expect(click({ state: "downloading", version: "1.2.3", mode: "automatic", percent: 1 })).toEqual([]);
	});

	it("toggles the window and quits", () => {
		const { template, actions } = menu({ state: "idle" });
		(template[0].click as () => void)();
		(template[3].click as () => void)();
		expect(actions.toggleWindow).toHaveBeenCalledOnce();
		expect(actions.quit).toHaveBeenCalledOnce();
	});
});

describe("menuSignature", () => {
	const input = (overrides: { windowVisible?: boolean; status?: UpdateStatus; lang?: "en" | "ko" } = {}) => {
		const lang = overrides.lang ?? "en";
		return {
			lang,
			windowVisible: overrides.windowVisible ?? true,
			update: trayUpdateItem(lang, overrides.status ?? { state: "idle" }, true),
		};
	};

	it("holds still for an unchanged state and changes with what a user can read", () => {
		const base = menuSignature(input());
		expect(menuSignature(input())).toBe(base);
		expect(menuSignature(input({ windowVisible: false }))).not.toBe(base);
		expect(menuSignature(input({ lang: "ko" }))).not.toBe(base);
		expect(menuSignature(input({ status: { state: "checking" } }))).not.toBe(base);
		const downloading = (percent: number): UpdateStatus => ({
			state: "downloading",
			version: "1.2.3",
			mode: "automatic",
			percent,
		});
		expect(menuSignature(input({ status: downloading(1) }))).not.toBe(
			menuSignature(input({ status: downloading(2) })),
		);
	});
});

describe("tray status surface", () => {
	it("names the run state in the hover text, in the language the renderer reports", () => {
		expect(trayTooltip(state({ status: "streaming" }))).toBe("OMPdesk — alpha · Working");
		expect(trayTooltip(state({ status: "approval", language: "ko" }))).toBe("OMPdesk — alpha · 승인 필요");
		for (const status of ["question", "childWaiting"] as const)
			expect(trayTooltip(state({ status, language: "ko" }))).toBe(`OMPdesk — alpha · ${statusLabel("ko", status)}`);
		expect(trayTooltip(state({ status: "error" }))).toContain("Error");
		expect(trayTooltip(state({ status: "idle" }))).toContain("Ready");
	});

	it("labels the project before any renderer state arrives", () => {
		expect(trayTooltip(null)).toBe("OMPdesk");
	});

	it("gives every status its own text", () => {
		const statuses = ["idle", "streaming", "question", "approval", "childWaiting", "error"] as const;
		expect(new Set(statuses.map(s => statusLabel("en", s))).size).toBe(statuses.length);
	});
});

describe("aggregateTrayStatus", () => {
	it("lets the loudest window win regardless of push order", () => {
		const windows = (statuses: TrayState["status"][]) => statuses.map(s => state({ status: s }));
		expect(aggregateTrayStatus(windows(["streaming", "error"]))).toBe("error");
		expect(aggregateTrayStatus(windows(["idle", "error"]))).toBe("error");
		expect(aggregateTrayStatus(windows(["approval", "streaming"]))).toBe("approval");
		expect(aggregateTrayStatus(windows(["streaming", "childWaiting"]))).toBe("childWaiting");
		expect(aggregateTrayStatus(windows(["idle", "streaming"]))).toBe("streaming");
		expect(aggregateTrayStatus(windows(["approval", "question"]))).toBe("question");
	});

	it("never lets a status it does not know hide an error or a wait", () => {
		const unknown = state({ status: "someday" as TrayState["status"] });
		expect(aggregateTrayStatus([unknown, state({ status: "error" })])).toBe("error");
		expect(aggregateTrayStatus([state({ status: "question" }), unknown])).toBe("question");
		expect(aggregateTrayStatus([unknown])).toBe("idle");
	});

	it("shows the app icon waiting while any window waits on the person, whatever another one runs", () => {
		expect(aggregateProgress(["working", "waiting"])).toBe("waiting");
		expect(aggregateProgress(["waiting", "working", "idle"])).toBe("waiting");
		expect(aggregateProgress(["idle", "working"])).toBe("working");
		expect(aggregateProgress([])).toBe("idle");
	});

	it("is idle with nothing to aggregate", () => {
		expect(aggregateTrayStatus([])).toBe("idle");
		expect(aggregateTrayStatus([state()])).toBe("idle");
	});
});
