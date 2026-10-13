import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { checkForUpdatesInPlace, useUpdaterStore } from "../../stores/updater";
import { SidebarUpdateCard, UP_TO_DATE_MS } from "./SidebarUpdateCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	click: () => void;
	remove: () => void;
	querySelectorAll: (selector: string) => TestElement[];
}

const check = vi.fn<() => Promise<UpdateStatus>>(() => Promise.resolve({ state: "checking" }));
const download = vi.fn(() => Promise.resolve({ state: "idle" } as const));
const apply = vi.fn(() => Promise.resolve());
Object.assign(window, { omp: { updater: { check, download, apply } } });

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {}, manualCheck: false });
	useUiStore.getState().closeDestination();
	vi.useRealTimers();
	check.mockClear();
	download.mockClear();
	apply.mockClear();
});

describe("SidebarUpdateCard", () => {
	// Actions are icon buttons: find them by their accessible name.
	const button = (label: string) =>
		container
			.querySelectorAll("button")
			.find(candidate => (candidate as never as Element).getAttribute("aria-label") === label);
	const card = () => container.querySelectorAll("[data-sidebar-update]")[0] as never as Element | undefined;

	it("stays out of the way while a background update downloads, then offers one restart", async () => {
		useUpdaterStore.setState({ status: { state: "available", version: "0.8.5", mode: "relaunch" }, dismissed: {} });
		await mount(<SidebarUpdateCard />);
		expect(container.textContent).toBe("");

		await act(async () => {
			useUpdaterStore.setState({
				status: {
					state: "downloading",
					version: "0.8.5",
					mode: "relaunch",
					percent: 40,
				},
			});
		});
		expect(container.textContent).toBe("");

		await act(async () => {
			useUpdaterStore.setState({ status: { state: "downloaded", version: "0.8.5", mode: "relaunch" } });
		});
		// One row: the version in a few words; the full sentence is the description.
		expect(container.textContent).toContain("Update 0.8.5 ready");
		expect(card()?.getAttribute("title")).toContain("installs the next time you quit");
		await act(async () => button("Restart to update")?.click());
		expect(apply).toHaveBeenCalledOnce();
		expect(download).not.toHaveBeenCalled();
	});

	it("offers the same restart for certificate-backed automatic updates", async () => {
		useUpdaterStore.setState({ status: { state: "downloaded", version: "0.8.5", mode: "automatic" }, dismissed: {} });
		await mount(<SidebarUpdateCard />);
		expect(button("Restart to update")).toBeDefined();
		expect(button("Open installer")).toBeUndefined();
	});

	it("walks the manual installer: download, then Finder guidance and reopen", async () => {
		useUpdaterStore.setState({ status: { state: "available", version: "0.8.5", mode: "manual" }, dismissed: {} });
		await mount(<SidebarUpdateCard />);
		await act(async () => button("Download installer")?.click());
		expect(download).toHaveBeenCalledOnce();

		await act(async () => {
			useUpdaterStore.setState({
				status: {
					state: "downloading",
					version: "0.8.5",
					mode: "manual",
					percent: 42,
				},
			});
		});
		expect(container.textContent).toContain("42%");
		expect(container.querySelectorAll("[data-update-progress]")).toHaveLength(1);

		await act(async () => {
			useUpdaterStore.setState({ status: { state: "downloaded", version: "0.8.5", mode: "manual" } });
		});
		expect(card()?.getAttribute("title")).toContain("drag OMPdesk into Applications");
		expect(button("Restart to update")).toBeUndefined();
		await act(async () => button("Open installer")?.click());
		expect(apply).toHaveBeenCalledOnce();
	});

	it("Later hides the card for that version only", async () => {
		useUpdaterStore.setState({ status: { state: "downloaded", version: "0.8.5", mode: "relaunch" }, dismissed: {} });
		await mount(<SidebarUpdateCard />);
		await act(async () => container.querySelectorAll('[aria-label="Later"]')[0]?.click());
		expect(container.textContent).toBe("");

		await act(async () => {
			useUpdaterStore.setState({ status: { state: "downloaded", version: "0.8.6", mode: "relaunch" } });
		});
		expect(container.textContent).toContain("Update 0.8.6 ready");
	});

	describe("a check from the app menu", () => {
		it("reports checking, then up to date in place, and fades out on its own", async () => {
			vi.useFakeTimers();
			const { promise, resolve } = Promise.withResolvers<UpdateStatus>();
			check.mockReturnValueOnce(promise);
			await mount(<SidebarUpdateCard />);
			await act(async () => {
				void checkForUpdatesInPlace();
			});
			expect(container.textContent).toContain("Checking for updates…");
			expect(useUiStore.getState().destination).toBe("session");

			await act(async () => resolve({ state: "not-available", version: "0.14.0" }));
			expect(container.textContent).toContain("OMPdesk 0.14.0 is up to date");
			expect(card()?.getAttribute("data-update-tone")).toBe("ok");

			await act(async () => vi.advanceTimersByTime(UP_TO_DATE_MS));
			expect(container.textContent).toBe("");
		});

		it("shows a failure with retry, and the retry checks again", async () => {
			check.mockResolvedValueOnce({ state: "error", message: "Couldn't check", showInBanner: true });
			await mount(<SidebarUpdateCard />);
			await act(async () => checkForUpdatesInPlace());
			expect(container.textContent).toContain("Update check failed");
			check.mockResolvedValueOnce({ state: "not-available", version: "0.14.0" });
			await act(async () => button("Check again")?.click());
			expect(check).toHaveBeenCalledTimes(2);
			expect(container.textContent).toContain("is up to date");
		});

		it("follows the background download it finds, even for a version put off earlier", async () => {
			useUpdaterStore.setState({ dismissed: { version: "0.15.0" } });
			check.mockResolvedValueOnce({ state: "available", version: "0.15.0", mode: "relaunch" });
			await mount(<SidebarUpdateCard />);
			await act(async () => checkForUpdatesInPlace());
			expect(container.textContent).toContain("Update 0.15.0 available");
			await act(async () => {
				useUpdaterStore.setState({
					status: {
						state: "downloading",
						version: "0.15.0",
						mode: "relaunch",
						percent: 30,
					},
				});
			});
			expect(container.textContent).toContain("30%");
			await act(async () => {
				useUpdaterStore.setState({ status: { state: "downloaded", version: "0.15.0", mode: "relaunch" } });
			});
			expect(button("Restart to update")).toBeDefined();
		});

		it("opens the update settings only when GitHub access is missing", async () => {
			check.mockResolvedValueOnce({ state: "auth-required", reason: "missing" });
			await mount(<SidebarUpdateCard />);
			await act(async () => checkForUpdatesInPlace());
			expect(useUiStore.getState().destination).toBe("session");
			await act(async () => button("Open update settings")?.click());
			expect(useUiStore.getState().destination).toBe("settings");
			expect(useUiStore.getState().settingsTab).toBe("updates");
		});
	});
});
