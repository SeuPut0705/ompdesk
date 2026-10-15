/**
 * Remote folder picker: starts at the host's home, walks down and up through
 * `remote.listDirs`, asks the host again for a name filter, and picks the
 * folder it shows.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteDirListing } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { RemoteFolderPicker } from "./RemoteFolderPicker";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const TREE: Record<string, RemoteDirListing> = {
	"/Users/kim": {
		path: "/Users/kim",
		parent: "/Users",
		entries: [
			{ name: "code", path: "/Users/kim/code" },
			{ name: "notes", path: "/Users/kim/notes" },
		],
	},
	"/Users/kim/code": {
		path: "/Users/kim/code",
		parent: "/Users/kim",
		entries: [{ name: "app", path: "/Users/kim/code/app" }],
	},
	"/Users/kim/code/app": { path: "/Users/kim/code/app", parent: "/Users/kim/code", entries: [] },
	"/Users/kim/notes": { path: "/Users/kim/notes", parent: "/Users/kim", entries: [] },
};

const listDirs = vi.fn(async (_deviceId: string, path?: string, query?: string): Promise<RemoteDirListing> => {
	const listing = TREE[path ?? "/Users/kim"];
	if (!listing) throw new Error(`[remote_offline] no ${path}`);
	if (!query) return listing;
	const needle = query.toLowerCase();
	return { ...listing, entries: listing.entries.filter(entry => entry.name.toLowerCase().includes(needle)) };
});
Object.assign(window as unknown as Record<string, unknown>, { omp: { remote: { listDirs } } });

const roots: Root[] = [];
const onPick = vi.fn();

async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RemoteFolderPicker deviceId="dev-studio" deviceName="studio" onClose={() => {}} onPick={onPick} open />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

async function click(selector: string): Promise<void> {
	const element = document.body.querySelector(selector) as HTMLButtonElement | null;
	if (!element) throw new Error(`no ${selector}`);
	await act(async () => element.click());
	await act(async () => {
		await Promise.resolve();
	});
}

const shownPath = () => document.body.querySelector("[data-remote-picker-path]")?.textContent;
const shownDirs = () =>
	[...document.body.querySelectorAll("[data-remote-dir]")].map(row => row.getAttribute("data-remote-dir"));

/**
 * Linkedom has no native value tracking, so call the field's own controlled
 * handler (as ProvidersSection.test.tsx does), then wait out the filter's typing pause.
 */
async function filterBy(value: string): Promise<void> {
	const field = document.body.querySelector("[data-remote-picker-filter]") as unknown as Record<
		string,
		unknown
	> | null;
	if (!field) throw new Error("no filter field");
	field.value = value;
	const propsKey = Object.getOwnPropertyNames(field).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (field[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: field, currentTarget: field }));
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 200);
		await promise;
	});
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	vi.clearAllMocks();
});

describe("RemoteFolderPicker", () => {
	it("browses the host's folders through listDirs and picks the one shown", async () => {
		await mount();

		expect(listDirs).toHaveBeenCalledWith("dev-studio");
		expect(document.body.textContent).toContain(translate("remote.picker.title", { name: "studio" }));
		expect(shownPath()).toBe("/Users/kim");

		await click('[data-remote-dir="/Users/kim/code"]');
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim/code");
		expect(shownPath()).toBe("/Users/kim/code");

		await click('[data-remote-dir="/Users/kim/code/app"]');
		expect(shownPath()).toBe("/Users/kim/code/app");
		expect(document.body.textContent).toContain(translate("remote.picker.empty"));

		await click("[data-remote-picker-up]");
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim/code");
		expect(shownPath()).toBe("/Users/kim/code");

		await click("[data-remote-picker-open]");
		expect(onPick).toHaveBeenCalledWith("/Users/kim/code");
	});

	it("shows a localized failure with a retry when a folder can't be read", async () => {
		listDirs.mockRejectedValueOnce(new Error("[remote_offline] link down"));
		await mount();

		const alert = document.body.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain(translate("ipcError.remote_offline"));
		await click('[role="alert"] button');
		expect(shownPath()).toBe("/Users/kim");
	});

	it("finds a folder past the host's bound through the filter, and leaves the filter behind on opening one", async () => {
		listDirs.mockResolvedValueOnce({ ...TREE["/Users/kim"], truncated: true });
		await mount();
		expect(document.body.querySelector("[data-remote-picker-truncated]")?.textContent).toBe(
			translate("remote.picker.truncated"),
		);

		await filterBy("NOT");
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim", "NOT");
		expect(shownDirs()).toEqual(["/Users/kim/notes"]);
		expect(document.body.querySelector("[data-remote-picker-truncated]")).toBeNull();

		await filterBy("zzz");
		expect(shownDirs()).toEqual([]);
		expect(document.body.textContent).toContain(translate("remote.picker.noMatch", { query: "zzz" }));

		await filterBy("no");
		await click('[data-remote-dir="/Users/kim/notes"]');
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim/notes");
		expect(shownPath()).toBe("/Users/kim/notes");
		expect((document.body.querySelector("[data-remote-picker-filter]") as HTMLInputElement | null)?.value).toBe("");
	});

	it("opens a folder clicked while the filter's answer is still on its way, and the late answer stays out", async () => {
		await mount();
		const late = Promise.withResolvers<RemoteDirListing>();
		listDirs.mockImplementationOnce(() => late.promise);
		await filterBy("no");
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim", "no");

		await click('[data-remote-dir="/Users/kim/notes"]');
		expect(listDirs).toHaveBeenLastCalledWith("dev-studio", "/Users/kim/notes");
		expect(shownPath()).toBe("/Users/kim/notes");

		await act(async () => late.resolve({ ...TREE["/Users/kim"], entries: [] }));
		expect(shownPath()).toBe("/Users/kim/notes");
	});
});
