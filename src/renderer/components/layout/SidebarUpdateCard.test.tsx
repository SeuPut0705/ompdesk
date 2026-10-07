import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { SidebarUpdateCard } from "./SidebarUpdateCard";

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

const check = vi.fn(() => Promise.resolve({ state: "checking" } as const));
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
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
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
					bytesPerSecond: 1,
					transferred: 40,
					total: 100,
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
					bytesPerSecond: 1,
					transferred: 42,
					total: 100,
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
});
