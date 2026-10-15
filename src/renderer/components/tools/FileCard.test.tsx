/**
 * File cards (A26 draft attachments, A111 reply documents): what the card
 * reads off the tab's files (fs.stat / fs.read) and how it reads; the draft
 * strip's mention parsing, hidden non-files and removal. Linkedom harness.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcFsReadResult, IpcFsStatResult } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";

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
	src: { stat: { ok: true, mtimeMs: 1, size: 96, directory: true } },
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
Object.assign(window, { omp: { fs: { stat, read } } });

// After the linkedom globals above: react-dom and the components read `document`/`window` when they load.
const { createRoot } = await import("react-dom/client");
const { FileCard } = await import("./FileCard");
const { DraftFileCards } = await import("../layout/DraftFileCards");

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
});

describe("FileCard", () => {
	it("shows a CSV's first rows with its row count and size", async () => {
		await render(<FileCard path="data/rows.csv" />);
		expect(meta()).toEqual(["CSV · 3 rows · 2.0 KB"]);
		expect(container.querySelector("table")?.textContent).toContain("bolt");
		expect(container.querySelector("[data-file-card]")?.getAttribute("data-file-card")).toBe("csv");
	});

	it("counts a text file's lines, and a folder is a folder without a size", async () => {
		await render(
			<>
				<FileCard path="notes.md" />
				<FileCard path="src" />
			</>,
		);
		expect(meta()).toEqual(["Text · 3 lines · 40 B", "Folder"]);
		expect(container.querySelector("pre")?.textContent).toContain("# Notes");
	});

	it("reads Deleted once the file is gone, or hides when the caller asks", async () => {
		await render(<FileCard path="out/report.xlsx" />);
		expect(meta()).toEqual(["Deleted"]);
		expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(true);
		await act(async () => root.unmount());
		await render(<FileCard hideMissing path="out/report.xlsx" />);
		expect(container.querySelector("[data-file-card]")).toBeNull();
	});
});

describe("DraftFileCards", () => {
	it("cards the draft's existing mentions after it settles and removes one", async () => {
		const onRemove = vi.fn();
		await render(<DraftFileCards onRemove={onRemove} text="" />);
		vi.useFakeTimers();
		const draft = "compare @notes.md with @nothing-here and @data/rows.csv";
		await act(async () => {
			root.render(
				<I18nProvider>
					<DraftFileCards onRemove={onRemove} text={draft} />
				</I18nProvider>,
			);
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
		// `@nothing-here` names no file, so it gets no card.
		expect([...container.querySelectorAll("[data-file-card]")]).toHaveLength(2);
		const remove = container.querySelector('button[aria-label="Remove notes.md"]');
		await act(async () => {
			remove?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(onRemove).toHaveBeenCalledWith("notes.md");
	});
});
