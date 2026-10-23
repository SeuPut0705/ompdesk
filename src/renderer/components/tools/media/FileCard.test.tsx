/**
 * File cards (draft attachments, the files a reply or prompt names): what the
 * card reads off the tab's files (fs.stat / fs.read / fs.readImage) and how it
 * draws them (a card with what it holds, a row for the rest); what a person can
 * do with the file from where they sit (show it in Finder here, save it here
 * from a paired host); the draft strip's mention parsing, hidden non-files and
 * removal. Linkedom harness.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsReadImageResult, IpcFsReadResult, IpcFsStatResult } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";

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

const files: Record<string, { stat: IpcFsStatResult; content?: string }> = {
	"data/rows.csv": { stat: { ok: true, mtimeMs: 1, size: 2_048 }, content: "name,qty\nbolt,3\nnut,9\n" },
	"notes.md": { stat: { ok: true, mtimeMs: 1, size: 40 }, content: "# Notes\nline two\nline three\n" },
	"dist/app.zip": { stat: { ok: true, mtimeMs: 1, size: 1_024 } },
	"/tmp/board.html": {
		stat: { ok: true, mtimeMs: 1, size: 7_900 },
		content: "<h1>Board</h1><script>alert(1)</script>",
	},
	"shots/home.png": { stat: { ok: true, mtimeMs: 1, size: 8 } },
};
const missing: IpcFsStatResult = { ok: false, mtimeMs: 0, size: 0, error: "gone", code: "file_not_found" };
const stat = vi.fn(async (path: string): Promise<IpcFsStatResult> => files[path]?.stat ?? missing);
const read = vi.fn(
	async (path: string): Promise<IpcFsReadResult> => ({
		ok: true,
		content: files[path]?.content ?? "",
		truncated: false,
		binary: false,
		size: files[path]?.stat.size ?? 0,
	}),
);
const readImage = vi.fn(
	async (): Promise<IpcFsReadImageResult> => ({
		ok: true,
		dataUrl: "data:image/png;base64,iVBORw0KGgo=",
		mime: "image/png",
		size: 8,
	}),
);
const saveCopy = vi.fn(async () => ({ ok: true, savedTo: "/Users/me/Downloads/app.zip" }));
const revealCopy = vi.fn(async () => ({ ok: true }));
const revealPath = vi.fn(async () => ({ ok: true }));
const openPath = vi.fn(async () => ({ ok: true }));
Object.assign(window, {
	omp: { fs: { stat, read, readImage, saveCopy, revealCopy }, system: { revealPath, openPath } },
});

// After the linkedom globals above: react-dom and the components read `document`/`window` when they load.
const { createRoot } = await import("react-dom/client");
const { FileCard } = await import("./FileCard");
const { DraftFileCards } = await import("../../layout/composer/DraftFileCards");

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function render(node: React.ReactNode): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	for (let i = 0; i < 4; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

function meta(): string[] {
	return [...container.querySelectorAll("[data-file-card-meta]")].map(node => node.textContent ?? "");
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	vi.useRealTimers();
	stat.mockClear();
	read.mockClear();
	saveCopy.mockClear();
	revealPath.mockClear();
	useTabsStore.setState({ tabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

async function click(selector: string): Promise<void> {
	const target = container.querySelector(selector);
	if (!target) throw new Error(`no ${selector}`);
	await act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true }));
	});
	for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
}

function menuLabels(): string[] {
	return [...document.querySelectorAll("[role='menuitem']")].map(item => item.textContent ?? "");
}

describe("FileCard", () => {
	it("shows a CSV's first rows with its row count and size", async () => {
		await render(<FileCard path="data/rows.csv" />);
		expect(meta()).toEqual(["CSV · 3 rows · 2.0 KB"]);
		expect(container.querySelector("table")?.textContent).toContain("bolt");
		expect(container.querySelector("[data-file-card]")?.getAttribute("data-file-card")).toBe("csv");
	});

	it("reads Deleted once the file is gone, or hides when the caller asks", async () => {
		await render(<FileCard path="out/report.xlsx" />);
		expect(meta()).toEqual(["Deleted"]);
		expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(true);
		await act(async () => root.unmount());
		await render(<FileCard hideMissing path="out/report.xlsx" />);
		expect(container.querySelector("[data-file-card]")).toBeNull();
	});

	it("draws what a file holds as a card and anything else as a row named by its extension", async () => {
		await render(
			<>
				<FileCard path="/tmp/board.html" />
				<FileCard path="shots/home.png" />
				<FileCard path="dist/app.zip" />
			</>,
		);
		const cards = [...container.querySelectorAll("[data-file-card]")];
		expect(cards.map(card => [card.getAttribute("data-file-card"), card.getAttribute("data-shape")])).toEqual([
			["html", "card"],
			["image", "card"],
			["archive", "row"],
		]);
		expect(meta()).toEqual(["Web page · 7.7 KB", "Image · 8 B", "ZIP · 1.0 KB"]);
		// The page is drawn in an empty sandbox that takes no click; the picture is the file's own bytes.
		const frame = cards[0]?.querySelector("iframe");
		expect(frame?.getAttribute("sandbox")).toBe("");
		expect(frame?.getAttribute("srcDoc")).toContain("<h1>Board</h1>");
		expect(cards[1]?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(cards[2]?.querySelector("iframe, img, table")).toBeNull();
	});

	it("on this computer, reveals the file in Finder and offers to open it in its app", async () => {
		useTabsStore.setState({ tabs: [{ id: "t1" } as never], activeTabId: "t1" });
		await render(<FileCard path="dist/app.zip" />);
		await click("[data-file-card-action='reveal']");
		expect(revealPath).toHaveBeenCalledWith("dist/app.zip", undefined);
		await click("button[aria-label='More for app.zip']");
		expect(menuLabels()).toEqual(["Preview", "Open in default app", "Reveal in Finder", "Save a copy…", "Copy path"]);
	});

	it("on a paired computer's tab, saves the file here and offers nothing native", async () => {
		useTabsStore.setState({ tabs: [{ id: "t1", device: "host-1" } as never], activeTabId: "t1" });
		await render(<FileCard path="dist/app.zip" />);
		expect(container.querySelector("[data-file-card-action='reveal']")).toBeNull();
		await click("[data-file-card-action='save']");
		expect(saveCopy).toHaveBeenCalledWith("dist/app.zip", undefined);
		const [saved] = useToastStore.getState().toasts;
		expect(saved?.message).toBe("Saved to /Users/me/Downloads/app.zip");
		// Its reveal shows the copy on this computer, never asking the host's tab in front.
		await act(async () => saved?.action?.run());
		expect(revealCopy).toHaveBeenCalledWith("/Users/me/Downloads/app.zip");
		expect(revealPath).not.toHaveBeenCalled();
		await click("button[aria-label='More for app.zip']");
		expect(menuLabels()).toEqual(["Preview", "Save to this computer", "Copy path"]);
	});
});

describe("DraftFileCards", () => {
	it("chips the draft's existing mentions after it settles, removes one or all, and hands focus back", async () => {
		const onRemove = vi.fn();
		const onRemoveAll = vi.fn();
		const focusField = vi.fn();
		const cards = (text: string) => (
			<DraftFileCards focusField={focusField} onRemove={onRemove} onRemoveAll={onRemoveAll} text={text} />
		);
		await render(cards(""));
		vi.useFakeTimers();
		const draft = "compare @notes.md with @nothing-here and @data/rows.csv";
		await act(async () => {
			root.render(<I18nProvider>{cards(draft)}</I18nProvider>);
		});
		// Settling: nothing is stat'ed for a draft still being typed.
		expect(stat).not.toHaveBeenCalled();
		await act(async () => {
			vi.advanceTimersByTime(300);
		});
		vi.useRealTimers();
		for (let i = 0; i < 4; i++) {
			await act(async () => {
				await Promise.resolve();
			});
		}
		expect(stat.mock.calls.map(call => call[0])).toEqual(["notes.md", "nothing-here", "data/rows.csv"]);
		// `@nothing-here` names no file, so it gets no chip; a chip reads no preview of the file.
		expect([...container.querySelectorAll("[data-file-card]")]).toHaveLength(2);
		expect(read).not.toHaveBeenCalled();
		expect(container.querySelector("table, pre, canvas")).toBeNull();
		expect(container.querySelector("[data-file-card]")?.getAttribute("title")).toContain("notes.md");
		// Two chips: one tab stop each strip comes from the roving hook; Remove all takes both.
		const removeAll = container.querySelector("button[data-strip-stop]:not([aria-label])");
		expect(removeAll?.textContent).toBe("Remove all");
		await act(async () => {
			removeAll?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(onRemoveAll).toHaveBeenCalledWith(["notes.md", "data/rows.csv"]);
		const remove = container.querySelector('button[aria-label="Remove notes.md"]');
		await act(async () => {
			remove?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(onRemove).toHaveBeenCalledWith("notes.md");
		expect(focusField).toHaveBeenCalledTimes(2);
	});
});
