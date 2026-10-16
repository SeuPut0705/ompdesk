/**
 * The chat's players, thumbnails and previews. A local tab's audio/video plays
 * from main's `omp-media://` stream (any size, seekable); a paired host's tab
 * reads its bytes through `fs.readBinary` under the host's cap. Everything
 * reads only once it nears the viewport, for the tab it belongs to; missing,
 * refused, oversized and undecodable files show their chip; a player never
 * autoplays or loops and starts muted; a page previews only on request, in an
 * empty sandbox; a picture a tool already showed is not drawn twice.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	IpcFsMediaStreamResult,
	IpcFsReadBinaryResult,
	IpcFsReadImageResult,
	IpcFsReadResult,
} from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "../../../lib/markdown";
import { useSessionStore } from "../../../stores/session";
import { SessionRuntimeProvider } from "../../../stores/session-runtime-context";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { MessageBubble } from "../../chat/MessageBubble";
import { ReplyFiles } from "../../chat/ReplyFiles";
import { ChatMedia, HtmlPreview, PdfThumb, ToolResultMedia } from "./ToolMedia";

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

type MediaStream = (path: string, tabId?: string) => Promise<IpcFsMediaStreamResult>;
type ReadBinary = (path: string, maxBytes?: number, tabId?: string) => Promise<IpcFsReadBinaryResult>;
type ReadImage = (path: string, tabId?: string) => Promise<IpcFsReadImageResult>;
type ReadText = (path: string, maxBytes?: number, tabId?: string) => Promise<IpcFsReadResult>;

interface FsMock {
	mediaStream: Mock<MediaStream>;
	releaseMediaStream: Mock<(url: string) => void>;
	readBinary: Mock<ReadBinary>;
	readImage: Mock<ReadImage>;
	read: Mock<ReadText>;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function streams(files: Record<string, { mime: string; size: number }>) {
	return vi.fn<MediaStream>(async path => {
		const file = files[path];
		if (path.startsWith("../")) return { ok: false, error: "escape", code: "path_escapes_workspace" };
		if (!file) return { ok: false, error: "missing", code: "file_not_found" };
		return { ok: true, url: `omp-media://stream/${encodeURIComponent(path)}`, ...file };
	});
}

function binaryFailure(code: string, size = 0, mime = "application/octet-stream"): IpcFsReadBinaryResult {
	return {
		ok: false,
		data: new Uint8Array(0),
		mime,
		size,
		truncated: false,
		error: code,
		code,
	} as IpcFsReadBinaryResult;
}

let fs: FsMock;
let container: HTMLElement;
let root: Root;

function install(overrides: Partial<FsMock> = {}): FsMock {
	fs = {
		mediaStream: streams({}),
		releaseMediaStream: vi.fn(),
		readBinary: vi.fn<ReadBinary>(async () => binaryFailure("file_not_found")),
		readImage: vi.fn<ReadImage>(async () => ({ ok: true, dataUrl: PNG, mime: "image/png", size: 8 })),
		read: vi.fn<ReadText>(
			async () =>
				({
					ok: true,
					content: "<h1>Page</h1><script>alert(1)</script>",
					truncated: false,
					size: 40,
				}) as IpcFsReadResult,
		),
		...overrides,
	};
	(window as unknown as Record<string, unknown>).omp = {
		fs,
		system: { openPath: vi.fn(async () => ({ ok: true })) },
	};
	return fs;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await act(async () => {});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await settle();
}

async function unmount(): Promise<void> {
	await act(async () => root.unmount());
	container.remove();
	await settle();
}

beforeEach(() => {
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${Math.random()}`);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useUiStore.setState({ filePreviewPath: null });
	useToolsStore.getState().reset();
	useSessionStore.setState({ cwd: "" });
	vi.restoreAllMocks();
	Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

describe("chat media player", () => {
	it("streams a local video from main: controls, first frame, muted, no autoplay or loop, no bytes in the renderer", async () => {
		install({ mediaStream: streams({ "out/demo.webm": { mime: "video/webm", size: 600 } }) });
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		const video = container.querySelector("video") as unknown as HTMLVideoElement | null;
		expect(video?.getAttribute("src")).toBe("omp-media://stream/out%2Fdemo.webm");
		expect(video?.hasAttribute("controls")).toBe(true);
		expect(video?.getAttribute("preload")).toBe("metadata");
		expect(video?.muted).toBe(true);
		expect(video?.hasAttribute("autoplay")).toBe(false);
		expect(video?.hasAttribute("loop")).toBe(false);
		expect(fs.readBinary).not.toHaveBeenCalled();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		expect(container.querySelector(".omp-chat-media-name")?.textContent).toBe("demo.webm");
	});

	it("plays a file of any size on this device: the stream has no cap", async () => {
		install({ mediaStream: streams({ "long.mp4": { mime: "video/mp4", size: 4 * 1024 ** 3 } }) });
		await mount(<ChatMedia kind="video" path="long.mp4" />);
		expect(container.querySelector("video")).not.toBeNull();
		expect(container.querySelector("[data-chat-media-too-large]")).toBeNull();
	});

	it("plays audio with native controls and no autoplay", async () => {
		install({ mediaStream: streams({ "tone.mp3": { mime: "audio/mpeg", size: 5 } }) });
		await mount(<ChatMedia kind="audio" path="tone.mp3" />);
		const audio = container.querySelector("audio");
		expect(audio?.hasAttribute("controls")).toBe(true);
		expect(audio?.hasAttribute("autoplay")).toBe(false);
	});

	it("waits for the viewport before asking for anything", async () => {
		const observers: { callback: IntersectionObserverCallback }[] = [];
		class FakeObserver {
			constructor(public callback: IntersectionObserverCallback) {
				observers.push(this);
			}
			observe() {}
			disconnect() {}
		}
		(globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver;
		install({ mediaStream: streams({ "out/demo.webm": { mime: "video/webm", size: 600 } }) });
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		expect(fs.mediaStream).not.toHaveBeenCalled();
		expect(container.querySelector("[data-chat-media='video']")?.getAttribute("data-state")).toBe("idle");
		await act(async () => {
			observers[0]?.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		});
		await settle();
		expect(fs.mediaStream).toHaveBeenCalledTimes(1);
		expect(container.querySelector("video")).not.toBeNull();
	});

	it("shows a missing file, or one outside the workspace, as its chip", async () => {
		install();
		for (const path of ["gone.mp4", "../escape.mp4"]) {
			await mount(<ChatMedia kind="video" path={path} />);
			expect(container.querySelector("video")).toBeNull();
			const chip = container.querySelector("[data-chat-media-unavailable='video']");
			expect(chip?.textContent).toContain(path.split("/").at(-1));
			expect(chip?.getAttribute("title")).toContain("File unavailable");
			await unmount();
		}
	});

	it("reads a remote tab's file on its host: a blob under the host's cap, the cap as a chip", async () => {
		const remote = vi.fn<MediaStream>(async () => ({ ok: false, error: "remote", code: "remote_path_native" }));
		install({
			mediaStream: remote,
			readBinary: vi.fn<ReadBinary>(async path =>
				path === "big.mp4"
					? binaryFailure("file_too_large", 12_000_000, "video/mp4")
					: {
							ok: true,
							data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
							mime: "video/webm",
							size: 4,
							truncated: false,
						},
			),
		});
		const runtime = { tabId: "remote-tab", command: vi.fn(), stores: new Map() };
		await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<ChatMedia kind="video" path="clip.webm" />
				<ChatMedia kind="video" path="big.mp4" />
			</SessionRuntimeProvider>,
		);
		expect(remote.mock.calls).toEqual([
			["clip.webm", "remote-tab"],
			["big.mp4", "remote-tab"],
		]);
		expect(fs.readBinary.mock.calls).toEqual([
			["clip.webm", undefined, "remote-tab"],
			["big.mp4", undefined, "remote-tab"],
		]);
		expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:test\//);
		expect(container.querySelector("[data-chat-media-too-large='video']")?.getAttribute("title")).toContain(
			"Too large to play here (11.4 MB)",
		);
	});

	it("falls back to the chip when the file does not decode", async () => {
		install({ mediaStream: streams({ "odd.mkv": { mime: "video/x-matroska", size: 10 } }) });
		await mount(<ChatMedia kind="video" path="odd.mkv" />);
		await act(async () => container.querySelector("video")?.dispatchEvent(new Event("error")));
		expect(container.querySelector("video")).toBeNull();
		expect(container.querySelector("[data-chat-media-unavailable='video']")?.getAttribute("title")).toContain(
			"Can't play this file here",
		);
	});

	it("opens the file in the Files viewer", async () => {
		install({ mediaStream: streams({ "out/demo.webm": { mime: "video/webm", size: 600 } }) });
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		const open = container.querySelector("button[aria-label='Open in Files']") as unknown as HTMLButtonElement;
		await act(async () => open.dispatchEvent(new Event("click", { bubbles: true })));
		expect(useUiStore.getState().filePreviewPath).toBe("out/demo.webm");
	});

	it("shares one stream between players of the same file and releases it after the last", async () => {
		install({ mediaStream: streams({ "/w/out/demo.webm": { mime: "video/webm", size: 600 } }) });
		const read = { content: [], details: { mediaPath: "/w/out/demo.webm" } };
		await mount(
			<>
				<ToolResultMedia args={{ path: "out/demo.webm" }} result={read} toolName="read" />
				<ChatMedia kind="video" path="/w/out/demo.webm" />
			</>,
		);
		expect(container.querySelectorAll("video")).toHaveLength(2);
		expect(fs.mediaStream).toHaveBeenCalledTimes(1);
		await unmount();
		expect(fs.releaseMediaStream.mock.calls).toEqual([["omp-media://stream/%2Fw%2Fout%2Fdemo.webm"]]);
	});
});

describe("document previews", () => {
	it("previews a page only on request, in an empty sandbox", async () => {
		install();
		await mount(<HtmlPreview path="site/index.html" />);
		expect(fs.read).not.toHaveBeenCalled();
		expect(container.querySelector("iframe")).toBeNull();
		const toggle = container.querySelector("button[aria-label='Preview']") as unknown as HTMLButtonElement;
		await act(async () => toggle.dispatchEvent(new Event("click", { bubbles: true })));
		await settle();
		const frame = container.querySelector("iframe");
		expect(frame?.getAttribute("sandbox")).toBe("");
		// linkedom keeps React's attribute spelling; a real DOM lowercases it to `srcdoc`.
		expect(frame?.getAttribute("srcDoc")).toContain("<h1>Page</h1>");
		expect(fs.read).toHaveBeenCalledWith("site/index.html", 200_000);
		await act(async () =>
			container
				.querySelector("button[aria-label='Close preview']")
				?.dispatchEvent(new Event("click", { bubbles: true })),
		);
		expect(container.querySelector("iframe")).toBeNull();
	});

	it("falls back to the chip for a page it cannot read", async () => {
		install({
			read: vi.fn<ReadText>(async () => ({ ok: false, content: "", truncated: false, size: 0 }) as IpcFsReadResult),
		});
		await mount(<HtmlPreview path="../outside.html" />);
		await act(async () =>
			container.querySelector("button[aria-label='Preview']")?.dispatchEvent(new Event("click", { bubbles: true })),
		);
		await settle();
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector("[data-chat-file='html'].omp-file-chip")?.textContent).toContain("outside.html");
	});

	it("keeps a PDF it cannot read, or one too large to thumbnail, as its chip", async () => {
		install({
			readBinary: vi.fn<ReadBinary>(async path =>
				path === "huge.pdf"
					? {
							ok: true,
							data: new Uint8Array(512),
							mime: "application/pdf",
							size: 64 * 1024 * 1024,
							truncated: true,
						}
					: binaryFailure("path_escapes_workspace"),
			),
		});
		await mount(
			<>
				<PdfThumb path="../outside.pdf" />
				<PdfThumb path="huge.pdf" />
			</>,
		);
		const chips = [...container.querySelectorAll("[data-chat-file='pdf'].omp-file-chip")];
		expect(chips.map(chip => chip.textContent)).toEqual(["outside.pdf", expect.stringContaining("huge.pdf")]);
		expect(chips[1]?.getAttribute("title")).toContain("Too large to preview here (64.0 MB)");
		// Only the size probe was read for the huge one.
		expect(fs.readBinary.mock.calls.filter(call => call[0] === "huge.pdf")).toEqual([["huge.pdf", 512]]);
	});
});

describe("files a reply names", () => {
	beforeAll(() => preloadMarkdownPipeline());

	const render = (content: string) =>
		renderToStaticMarkup(
			<I18nProvider>
				<MarkdownRenderer content={content} />
			</I18nProvider>,
		);

	it("embeds a local video image as the player, a PDF as its first page and a page as its preview", () => {
		const html = parseHTML(
			`<div>${render("![demo](out/demo.mp4)\n\n![report](docs/report.pdf)\n\n![site](site/index.html)")}</div>`,
		).document;
		expect(html.querySelector("[data-chat-media='video']")).not.toBeNull();
		expect(html.querySelector("img")).toBeNull();
		expect(html.querySelector("[data-chat-file='pdf'] .omp-chat-thumb-caption")?.textContent).toBe("report");
		expect(html.querySelector("[data-chat-file='html'] .omp-chat-media-name")?.textContent).toBe("site");
	});

	it("renders raw <video>/<audio> only as the chat player: no autoplay, loop, poster or handlers survive", () => {
		const html = render(
			'<video src="out/demo.mp4" autoplay loop poster="https://evil.example/p.png" onplay="alert(1)"></video>\n\n<audio src="file:///tmp/tone.mp3" autoplay></audio>',
		);
		const doc = parseHTML(`<div>${html}</div>`).document;
		expect(doc.querySelector("[data-chat-media='video']")).not.toBeNull();
		expect(doc.querySelector("[data-chat-media='audio'] .omp-chat-media-name")?.textContent).toBe("tone.mp3");
		expect(html).not.toMatch(/autoplay|loop|poster|onplay|evil\.example/);
	});

	it("never loads a remote or script media source", () => {
		const remote = render('<video src="https://cdn.example.com/clip.mp4"></video>');
		expect(remote).not.toContain("<video");
		expect(remote).toContain("Remote media not loaded");
		const script = render('<video src="javascript:alert(1)"></video>');
		expect(script).not.toContain("javascript:");
		expect(script).not.toContain("data-chat-media");
	});

	it("lists the files a reply names under it, once each", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Saved [the demo](out/demo.webm), `out/demo.webm`, `tone.mp3`, `report.pdf` and [the page](site/index.html).",
							},
						],
						timestamp: "2026-10-14T00:00:00Z",
					}}
				/>
			</I18nProvider>,
		);
		const list = parseHTML(`<div>${html}</div>`).document.querySelector("[aria-label='Files in this reply']");
		expect(list?.querySelectorAll("[data-chat-media='video']")).toHaveLength(1);
		expect(list?.querySelectorAll("[data-chat-media='audio']")).toHaveLength(1);
		expect(list?.querySelector("[data-chat-file='pdf']")).not.toBeNull();
		expect(list?.querySelector("[data-chat-file='html'] .omp-chat-media-name")?.textContent).toBe("index.html");
	});

	it("draws pictures the reply names, except one a tool of this tab already showed", async () => {
		install();
		useSessionStore.setState({ cwd: "/w" });
		const shot: ToolEntry = {
			toolName: "read",
			args: { path: "shots/home.png" },
			status: "done",
			streamingArgs: "",
			isError: false,
			startTime: 1,
			endTime: 2,
			result: {
				content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
				details: { mediaPath: "/w/shots/home.png" },
			},
		};
		useToolsStore.setState({ finishedTools: new Map([["read-1", shot]]), finishedVersion: 1 });
		await mount(
			<ReplyFiles
				references={[
					{ path: "shots/home.png", kind: "image" },
					{ path: "./out/chart.svg", kind: "image" },
				]}
			/>,
		);
		const thumbs = [...container.querySelectorAll("[data-chat-file='image']")];
		expect(thumbs).toHaveLength(1);
		expect(thumbs[0]?.querySelector("img")?.getAttribute("src")).toBe(PNG);
		expect(fs.readImage.mock.calls).toEqual([["./out/chart.svg"]]);
	});

	it("shows a picture it cannot read as its chip", async () => {
		install({
			readImage: vi.fn<ReadImage>(async () => ({
				ok: false,
				dataUrl: null,
				mime: null,
				size: 0,
				code: "file_not_found",
			})),
		});
		await mount(<ReplyFiles references={[{ path: "gone.png", kind: "image" }]} />);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("[data-image-unavailable]")?.textContent).toContain("gone.png");
	});
});
