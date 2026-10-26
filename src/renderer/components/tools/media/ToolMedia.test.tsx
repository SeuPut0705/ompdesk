/**
 * The chat's players and the files a reply names. A local tab's audio/video
 * plays from main's `omp-media://` stream (any size, seekable); a paired host's
 * tab reads its bytes through `fs.readBinary` under the host's cap. Everything
 * reads only once it nears the viewport, for the tab it belongs to; missing,
 * refused, oversized and undecodable recordings show their chip; a player never
 * autoplays or loops and starts muted; every other file is a FileCard
 * (FileCard.test.tsx); a picture a tool already showed is not drawn twice.
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
import { ChatMedia, ToolResultMedia } from "./ToolMedia";

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
	stat: Mock<() => Promise<{ ok: boolean; mtimeMs?: number; size?: number; error?: string; code?: string }>>;
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
		stat: vi.fn(async () => ({ ok: true, mtimeMs: 1, size: 8 })),
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

	it("opens the file in the Files viewer from its menu", async () => {
		install({ mediaStream: streams({ "out/demo.webm": { mime: "video/webm", size: 600 } }) });
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		const more = container.querySelector("button[aria-label='More for demo.webm']") as unknown as HTMLButtonElement;
		await act(async () => more.dispatchEvent(new Event("click", { bubbles: true })));
		const preview = [...document.querySelectorAll("[role='menuitem']")].find(item => item.textContent === "Preview");
		await act(async () => preview?.dispatchEvent(new Event("click", { bubbles: true })));
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
		expect(html.querySelector("[data-file-card='pdf'] .omp-file-card-name")?.textContent).toBe("report");
		expect(html.querySelector("[data-file-card='html'] .omp-file-card-name")?.textContent).toBe("site");
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
		expect(list?.querySelector("[data-file-card='pdf']")).not.toBeNull();
		expect(list?.querySelector("[data-file-card='html'] .omp-file-card-name")?.textContent).toBe("index.html");
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
		const thumbs = [...container.querySelectorAll("[data-file-card='image']")];
		expect(thumbs).toHaveLength(1);
		expect(thumbs[0]?.querySelector("img")?.getAttribute("src")).toBe(PNG);
		expect(fs.readImage.mock.calls).toEqual([["./out/chart.svg"]]);
	});

	it("shows a picture it cannot read as its card's tile, never a broken image", async () => {
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
		expect(container.querySelector("[data-file-card='image'] .omp-file-card-tile")).not.toBeNull();
		expect(container.querySelector("[data-file-card='image'] .omp-file-card-name")?.textContent).toBe("gone.png");
	});

	it("draws nothing for a document the reply names that is gone, never a Deleted card", async () => {
		install({ stat: vi.fn(async () => ({ ok: false, error: "missing", code: "file_not_found" })) });
		await mount(<ReplyFiles references={[{ path: "요구사항.csv", kind: "document" }]} />);
		await vi.waitFor(() => expect(window.omp.fs.stat).toHaveBeenCalled());
		await vi.waitFor(() => expect(container.querySelector("[data-file-card]")).toBeNull());
		expect(container.textContent).not.toContain("Deleted");
	});

	it("draws the files a prompt attached as cards under it, without the line that only named them", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [
							{
								type: "text",
								text: 'Read this\n@"/up/this-computer/u1/report v2.docx"\nand @notes.md too, with @"C:\\Users\\kim\\My Docs\\plan.docx" and @kim',
							},
						],
						timestamp: "2026-10-14T00:00:00Z",
					}}
				/>
			</I18nProvider>,
		);
		const doc = parseHTML(`<div>${html}</div>`).document;
		const cards = [...doc.querySelectorAll("[data-prompt-files] [data-file-card]")];
		expect(cards.map(card => card.getAttribute("title"))).toEqual([
			"/up/this-computer/u1/report v2.docx",
			"notes.md",
			"C:\\Users\\kim\\My Docs\\plan.docx",
		]);
		const text = doc.querySelector(".omp-user-text")?.textContent ?? "";
		expect(text).not.toContain("this-computer");
		// A file a sentence names reads as its name, linking to the file.
		// A file a sentence names by its whole path reads as its name, linking to it; a relative one stays as written.
		const links = [...doc.querySelectorAll(".omp-user-text a")];
		expect(links.map(link => [link.textContent, link.getAttribute("href")])).toEqual([
			["plan.docx", `file://${encodeURIComponent("C:\\Users\\kim\\My Docs\\plan.docx")}`],
		]);
		expect(text).toBe("Read this\nand @notes.md too, with plan.docx and @kim");
	});

	it("keeps a text file it links inside the tab's folder as a citation and hands over one outside", async () => {
		install();
		useSessionStore.setState({ cwd: "/w" });
		await mount(
			<ReplyFiles
				references={[
					{ path: "/w/src/a.ts", kind: "file" },
					{ path: "/tmp/summary.md", kind: "file" },
					{ path: "/w/dist/app.zip", kind: "file" },
				]}
			/>,
		);
		expect([...container.querySelectorAll("[data-file-card]")].map(card => card.getAttribute("title"))).toEqual([
			"/tmp/summary.md",
			"/w/dist/app.zip",
		]);
	});
});
