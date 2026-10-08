/**
 * Files drawer viewer: extension dispatch, highlighted code with line numbers,
 * CSV quoting, JSON fallback, notebooks, the hex fallback, the too-large card,
 * and the script-free HTML sandbox. linkedom harness; `window.omp.fs` is a
 * per-test fake.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tinyPptx, tinyXlsx } from "../../../../../e2e/file-viewer-fixtures";
import type { IpcFsReadBinaryResult, IpcFsReadResult } from "../../../../shared/ipc-types";
import { loadHljs } from "../../../lib/highlight";
import { I18nProvider } from "../../../lib/i18n";
import { FileViewer } from "./FileViewer";
import { fileIconKind, viewerKind } from "./file-kind";
import { hexDump, parseDelimited, prettyJson } from "./parse";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const ompWindow = window as unknown as { omp?: unknown };

interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	hasAttribute: (name: string) => boolean;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
	dispatchEvent: (event: Event) => boolean;
}

let container: TestElement;
let root: Root | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
	await flush();
}

function textResult(content: string, extra: Partial<IpcFsReadResult> = {}): IpcFsReadResult {
	return { ok: true, content, truncated: false, binary: false, size: content.length, ...extra };
}

function binaryResult(data: Uint8Array, extra: Partial<IpcFsReadBinaryResult> = {}): IpcFsReadBinaryResult {
	return { ok: true, data, mime: "application/octet-stream", size: data.length, truncated: false, ...extra };
}

type ReadFn = (path: string, maxBytes?: number) => Promise<IpcFsReadResult>;
type ReadBinaryFn = (path: string, maxBytes?: number) => Promise<IpcFsReadBinaryResult>;

/** Installs the fake `window.omp.fs`; unset reads stay pending forever (loading state). */
function installFs(fs: { read?: ReadFn; readBinary?: ReadBinaryFn }) {
	const read = vi.fn<ReadFn>(fs.read ?? (async () => textResult("")));
	const readBinary = vi.fn<ReadBinaryFn>(
		fs.readBinary ?? (() => Promise.withResolvers<IpcFsReadBinaryResult>().promise),
	);
	ompWindow.omp = {
		fs: { read, readBinary, readImage: vi.fn(() => Promise.withResolvers<never>().promise) },
		system: { openPath: vi.fn(async () => ({ ok: true })) },
	};
	return { read, readBinary };
}

function view(path: string) {
	return <FileViewer onInfo={() => {}} path={path} tabId={undefined} />;
}

beforeAll(async () => {
	await loadHljs();
});

afterEach(async () => {
	if (root) {
		const mounted = root;
		await act(async () => {
			mounted.unmount();
		});
		root = null;
	}
	container?.remove();
	delete ompWindow.omp;
});

describe("viewer dispatch", () => {
	it("maps extensions to their viewer", () => {
		expect(
			Object.fromEntries(
				[
					"src/app.ts",
					"README.md",
					"logo.PNG",
					"icon.svg",
					"paper.pdf",
					"clip.mp3",
					"tone.wav",
					"movie.mp4",
					"data.csv",
					"data.tsv",
					"config.json",
					"events.jsonl",
					"index.html",
					"analysis.ipynb",
					"report.docx",
					"budget.XLSX",
					"deck.pptx",
					"legacy.xls",
					"blob.bin",
					"archive.zip",
					"Makefile",
				].map(path => [path, viewerKind(path)]),
			),
		).toEqual({
			"src/app.ts": "code",
			"README.md": "markdown",
			"logo.PNG": "image",
			"icon.svg": "image",
			"paper.pdf": "pdf",
			"clip.mp3": "audio",
			"tone.wav": "audio",
			"movie.mp4": "video",
			"data.csv": "csv",
			"data.tsv": "csv",
			"config.json": "json",
			"events.jsonl": "json",
			"index.html": "html",
			"analysis.ipynb": "notebook",
			"report.docx": "docx",
			"budget.XLSX": "xlsx",
			"deck.pptx": "pptx",
			"legacy.xls": "office",
			"blob.bin": "binary",
			"archive.zip": "binary",
			Makefile: "code",
		});
	});

	it("picks type-aware tree icons", () => {
		expect(
			["a.ts", "a.png", "a.mov", "a.flac", "a.pdf", "a.tar", "a.csv", "a.json", "notes.txt"].map(fileIconKind),
		).toEqual(["code", "image", "video", "audio", "pdf", "archive", "table", "json", "text"]);
	});

	it("routes binary kinds to readBinary and text kinds to read", async () => {
		const fs = installFs({});
		await mount(view("docs/paper.pdf"));
		expect(container.querySelector('[data-viewer-kind="pdf"]')).not.toBeNull();
		expect(container.querySelector('[role="status"]')).not.toBeNull();
		expect(fs.readBinary).toHaveBeenCalledWith("docs/paper.pdf", undefined);
		expect(fs.read).not.toHaveBeenCalled();
	});
});

describe("code view", () => {
	it("highlights with line numbers", async () => {
		installFs({ read: async () => textResult("const answer = 42;\nexport { answer };") });
		await mount(view("src/answer.ts"));
		const code = container.querySelector("[data-code-view]");
		expect(code?.getAttribute("data-highlighted")).toBe("true");
		expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");
		expect(container.querySelectorAll("[data-line-number]").map(n => n.textContent)).toEqual(["1", "2"]);
		expect(code?.textContent).toContain("const answer = 42;");
	});

	it("offers Load more for a truncated read", async () => {
		const read = vi.fn(async (_path: string, maxBytes?: number) =>
			textResult("line\n", { truncated: maxBytes !== 2_000_000, size: 500_000 }),
		);
		installFs({ read });
		await mount(view("notes.txt"));
		expect(container.querySelector("[data-truncated-note]")?.textContent).toContain("Load more");
		expect(read).toHaveBeenCalledWith("notes.txt", 200_000);
	});

	it("hands NUL-byte text to the hex view", async () => {
		installFs({
			read: async () => textResult("", { binary: true, size: 4 }),
			readBinary: async () => binaryResult(new Uint8Array([0, 1, 2, 3])),
		});
		await mount(view("weird.txt"));
		expect(container.querySelector("[data-hex-dump]")?.textContent).toContain("00 01 02 03");
	});
});

describe("table view", () => {
	it("parses quoted fields, doubled quotes and quoted newlines", () => {
		expect(parseDelimited('name,quote\n"Smith, J","He said ""hi"""\r\nplain,"two\nlines"\n', ",", 10)).toEqual({
			rows: [
				["name", "quote"],
				["Smith, J", 'He said "hi"'],
				["plain", "two\nlines"],
			],
			clipped: false,
		});
		expect(parseDelimited("a\tb\n1\t2", "\t", 10).rows).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(parseDelimited("h\n1\n2\n3\n", ",", 2)).toEqual({ rows: [["h"], ["1"]], clipped: true });
	});

	it("renders a sticky-header table with the quoted cells intact", async () => {
		installFs({ read: async () => textResult('name,quote\n"Smith, J","He said ""hi"""\n') });
		await mount(view("people.csv"));
		const table = container.querySelector("[data-table-view]");
		expect(table?.querySelectorAll("thead th").map(th => th.textContent)).toEqual(["", "name", "quote"]);
		expect(table?.querySelectorAll("tbody td").map(td => td.textContent)).toEqual(["Smith, J", 'He said "hi"']);
	});
});

describe("json view", () => {
	it("pretty-prints valid JSON and JSON Lines", () => {
		expect(prettyJson('{"a":[1,2]}', false)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
		expect(prettyJson('{"a":1}\n\n{"b":2}\n', true)).toBe('{\n  "a": 1\n}\n{\n  "b": 2\n}');
	});

	it("falls back to raw text for invalid JSON", async () => {
		installFs({ read: async () => textResult('{"a": 1,,}') });
		await mount(view("broken.json"));
		expect(container.querySelector("[data-json-invalid]")).not.toBeNull();
		const code = container.querySelector("[data-code-view]");
		expect(code?.getAttribute("data-language")).toBe("plaintext");
		expect(code?.textContent).toContain('{"a": 1,,}');
	});
});

describe("notebook view", () => {
	it("renders markdown cells, highlighted code cells and their outputs", async () => {
		const notebook = {
			cells: [
				{ cell_type: "markdown", source: ["# Analysis\n", "Some *notes*."] },
				{
					cell_type: "code",
					execution_count: 3,
					source: "print('hi')",
					outputs: [
						{ output_type: "stream", name: "stdout", text: ["hi\n"] },
						{ output_type: "display_data", data: { "image/png": "iVBORw0KGgo=\n", "text/plain": "<Figure>" } },
					],
				},
			],
			metadata: { language_info: { name: "python" } },
		};
		installFs({ read: async () => textResult(JSON.stringify(notebook)) });
		await mount(view("analysis.ipynb"));
		expect(container.querySelector('[data-cell="markdown"] h1')?.textContent).toBe("Analysis");
		const code = container.querySelector('[data-cell="code"]');
		expect(code?.textContent).toContain("In [3]");
		expect(code?.textContent).toContain("print('hi')");
		expect(code?.querySelector(".hljs-built_in, .hljs-string")).not.toBeNull();
		expect(code?.querySelector('[data-cell-output="text"]')?.textContent).toContain("hi");
		expect(code?.querySelector('[data-cell-output="image"] img')?.getAttribute("src")).toBe(
			"data:image/png;base64,iVBORw0KGgo=",
		);
	});
});

describe("binary fallback", () => {
	it("hex-dumps an unknown binary with file info and an open button", async () => {
		const bytes = new TextEncoder().encode("Hello, binary!\u0000\u0001");
		const readBinary = vi.fn(async () => binaryResult(bytes, { size: 100_000, truncated: true }));
		installFs({ readBinary });
		await mount(view("blob.bin"));
		expect(readBinary).toHaveBeenCalledWith("blob.bin", 65_536);
		expect(container.querySelector("[data-hex-dump]")?.textContent).toBe(hexDump(bytes));
		expect(hexDump(bytes)).toContain("48 65 6c 6c 6f 2c 20 62  69 6e 61 72 79 21 00 01  |Hello, binary!..|");
		const card = container.querySelector("[data-viewer-fallback]");
		expect(card?.textContent).toContain("application/octet-stream");
		expect(card?.textContent).toContain("Open with default app");
	});

	it("shows the too-large card when main refuses the whole file", async () => {
		installFs({
			readBinary: async () => ({
				ok: false,
				data: new Uint8Array(),
				mime: "video/mp4",
				size: 300 * 1024 * 1024,
				truncated: false,
				code: "file_too_large",
				error: "too large",
			}),
		});
		await mount(view("movie.mp4"));
		expect(container.querySelector("[data-viewer-fallback]")?.textContent).toContain("too large to preview");
		expect(container.querySelector("video")).toBeNull();
	});
});

describe("html view", () => {
	it("renders in an empty sandbox with no scripts, then shows source on request", async () => {
		installFs({ read: async () => textResult("<h1>Hi</h1><script>alert(1)</script>") });
		await mount(view("page.html"));
		const frame = container.querySelector("iframe[data-html-rendered]");
		expect(frame?.getAttribute("sandbox")).toBe("");
		expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
		// linkedom keeps React's attribute spelling; a real DOM lowercases it to `srcdoc`.
		expect(frame?.getAttribute("srcDoc")).toContain("<h1>Hi</h1>");
		expect(container.querySelector("[data-code-view]")).toBeNull();

		const source = container.querySelectorAll('[role="tab"]').find(tab => tab.textContent === "Source");
		await act(async () => {
			source?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector("[data-code-view]")?.textContent).toContain("<script>alert(1)</script>");
	});
});

describe("office views", () => {
	/** The readers load as lazy chunks and parse asynchronously; flush until the view settles. */
	async function settle(done: () => boolean): Promise<void> {
		for (let i = 0; i < 100 && !done(); i++) await flush();
	}

	it("shows workbook sheets as tabs and switches between them", async () => {
		const bytes = new Uint8Array(await tinyXlsx());
		const fs = installFs({ readBinary: async () => binaryResult(bytes) });
		await mount(view("budget.xlsx"));
		expect(fs.readBinary).toHaveBeenCalledWith("budget.xlsx", undefined);
		await settle(() => container.querySelector("[data-sheet-grid]") !== null);
		const tabs = () => container.querySelectorAll('[role="tab"]');
		expect(tabs().map(tab => tab.textContent)).toEqual(["Summary", "Regions"]);
		const cells = () => container.querySelectorAll("[data-sheet-grid] tbody td").map(td => td.textContent);
		expect(cells()).toContain('Said "hello", then left');
		expect(container.querySelectorAll("[data-sheet-grid] thead th").map(th => th.textContent)).toEqual([
			"",
			"A",
			"B",
		]);

		await act(async () => {
			tabs()[1]?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		await settle(() => cells().includes("North"));
		expect(cells()).toEqual(["Region", "Total", "North", "1,234.50"]);
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("lists slides with their text, notes and images", async () => {
		const bytes = new Uint8Array(await tinyPptx());
		installFs({ readBinary: async () => binaryResult(bytes) });
		await mount(view("deck.pptx"));
		await settle(() => container.querySelector("[data-slide]") !== null);
		expect(container.querySelector("[data-slides-simplified]")?.textContent).toContain("Simplified preview");
		expect(container.querySelectorAll("[data-slide]").map(slide => slide.getAttribute("data-slide"))).toEqual([
			"1",
			"2",
		]);
		expect(container.querySelector('[data-slide="1"] h3')?.textContent).toBe("Roadmap 2025");
		expect(container.querySelector('[data-slide="1"] [data-slide-notes]')?.textContent).toContain(
			"Mention remote tabs",
		);
		expect(container.querySelectorAll('[data-slide="2"] img[data-slide-image]')).toHaveLength(1);
	});

	it("ends in the too-large card or an error, never a spinner", async () => {
		installFs({
			readBinary: async () => ({
				ok: false,
				data: new Uint8Array(),
				mime: "application/zip",
				size: 200 * 1024 * 1024,
				truncated: false,
				code: "file_too_large",
				error: "too large",
			}),
		});
		await mount(view("deck.pptx"));
		expect(container.querySelector("[data-viewer-fallback]")?.textContent).toContain("too large to preview");
		root?.unmount();
		root = null;
		container.remove();

		installFs({ readBinary: async () => binaryResult(new TextEncoder().encode("not a zip")) });
		await mount(view("broken.xlsx"));
		await settle(() => container.querySelector('[role="alert"]') !== null);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read this document.");
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it("keeps the fallback card for formats without a reader", async () => {
		installFs({ readBinary: async () => binaryResult(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])) });
		await mount(view("legacy.xls"));
		expect(container.querySelector("[data-viewer-fallback]")?.textContent).toContain(
			"This document format can't be previewed here.",
		);
	});
});
