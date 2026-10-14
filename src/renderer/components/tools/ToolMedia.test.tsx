/**
 * The chat's audio/video player and file chips: bytes come only through the
 * Files viewer's `fs.readBinary` for the tab (a paired host's tab reads on the
 * host), only once the player nears the viewport and under the size cap;
 * missing, refused, oversized and undecodable files show their chip; the
 * player never autoplays or loops and starts muted.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcFsReadBinaryResult } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "../../lib/markdown";
import { CHAT_MEDIA_MAX_BYTES } from "../../lib/preview";
import { SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { MessageBubble } from "../chat/MessageBubble";
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

type ReadBinary = (path: string, maxBytes?: number, tabId?: string) => Promise<IpcFsReadBinaryResult>;

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(600).fill(0)]);

function ok(data: Uint8Array, size: number, mime: string, truncated = false): IpcFsReadBinaryResult {
	return { ok: true, data, mime, size, truncated };
}

function failed(code: string, size = 0, mime = "application/octet-stream"): IpcFsReadBinaryResult {
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

/** A file system holding `files`; a prefix read of a bigger file comes back truncated, as main does. */
function fakeFs(files: Record<string, { bytes: Uint8Array; mime: string } | IpcFsReadBinaryResult>) {
	return vi.fn<ReadBinary>(async (path, maxBytes) => {
		const file = files[path];
		if (!file) return failed("file_not_found");
		if ("ok" in file) return file;
		const take = maxBytes === undefined ? file.bytes.length : Math.min(maxBytes, file.bytes.length);
		return ok(file.bytes.slice(0, take), file.bytes.length, file.mime, take < file.bytes.length);
	});
}

let readBinary: Mock<ReadBinary>;
let container: HTMLElement;
let root: Root;

function install(read: Mock<ReadBinary>) {
	readBinary = read;
	(window as unknown as Record<string, unknown>).omp = {
		fs: { readBinary: read },
		system: { openPath: vi.fn(async () => ({ ok: true })) },
	};
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	// Two reads (probe, then the whole file) settle over a few microtasks.
	for (let i = 0; i < 4; i += 1) await act(async () => {});
}

beforeEach(() => {
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${Math.random()}`);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useUiStore.setState({ filePreviewPath: null });
	vi.restoreAllMocks();
	Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

describe("chat media player", () => {
	it("plays a local video through readBinary: controls, first frame, muted, no autoplay or loop", async () => {
		install(fakeFs({ "out/demo.webm": { bytes: WEBM, mime: "video/webm" } }));
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		const video = container.querySelector("video") as unknown as HTMLVideoElement | null;
		expect(video).not.toBeNull();
		expect(video?.getAttribute("src")).toMatch(/^blob:/);
		expect(video?.hasAttribute("controls")).toBe(true);
		expect(video?.getAttribute("preload")).toBe("metadata");
		expect(video?.muted).toBe(true);
		expect(video?.hasAttribute("autoplay")).toBe(false);
		expect(video?.hasAttribute("loop")).toBe(false);
		// The probe asks for a prefix; the whole file follows once it fits the cap.
		expect(readBinary.mock.calls.map(call => call[1])).toEqual([512, undefined]);
		expect(container.querySelector(".omp-chat-media-name")?.textContent).toBe("demo.webm");
	});

	it("plays audio with native controls and no autoplay", async () => {
		install(fakeFs({ "tone.mp3": { bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0]), mime: "audio/mpeg" } }));
		await mount(<ChatMedia kind="audio" path="tone.mp3" />);
		const audio = container.querySelector("audio");
		expect(audio?.hasAttribute("controls")).toBe(true);
		expect(audio?.hasAttribute("autoplay")).toBe(false);
		// A file inside the probe came back whole: one read.
		expect(readBinary).toHaveBeenCalledTimes(1);
	});

	it("waits for the viewport before reading anything", async () => {
		const observers: { callback: IntersectionObserverCallback; observed: unknown[] }[] = [];
		class FakeObserver {
			observed: unknown[] = [];
			constructor(public callback: IntersectionObserverCallback) {
				observers.push(this);
			}
			observe(element: unknown) {
				this.observed.push(element);
			}
			disconnect() {}
		}
		(globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver;
		install(fakeFs({ "out/demo.webm": { bytes: WEBM, mime: "video/webm" } }));
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		expect(readBinary).not.toHaveBeenCalled();
		expect(container.querySelector("video")).toBeNull();
		expect(container.querySelector("[data-chat-media='video']")?.getAttribute("data-state")).toBe("idle");
		await act(async () => {
			observers[0]?.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		});
		for (let i = 0; i < 4; i += 1) await act(async () => {});
		expect(readBinary).toHaveBeenCalled();
		expect(container.querySelector("video")).not.toBeNull();
	});

	it("shows a missing file, or one outside the workspace, as its chip", async () => {
		install(fakeFs({ "../escape.mp4": failed("path_escapes_workspace") }));
		for (const path of ["gone.mp4", "../escape.mp4"]) {
			await mount(<ChatMedia kind="video" path={path} />);
			expect(container.querySelector("video")).toBeNull();
			const chip = container.querySelector("[data-chat-media-unavailable='video']");
			expect(chip?.textContent).toContain(path.split("/").at(-1));
			expect(chip?.getAttribute("title")).toContain("File unavailable");
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("never reads a file over the cap: the probe's size decides", async () => {
		const size = CHAT_MEDIA_MAX_BYTES + 1;
		install(fakeFs({ "big.mp4": ok(new Uint8Array(512), size, "video/mp4", true) }));
		await mount(<ChatMedia kind="video" path="big.mp4" />);
		expect(readBinary).toHaveBeenCalledTimes(1);
		expect(container.querySelector("video")).toBeNull();
		expect(container.querySelector("[data-chat-media-too-large='video']")?.getAttribute("title")).toContain(
			"Too large to play here (32.0 MB)",
		);
	});

	it("reads a remote tab's file on its host and shows the host's cap as too large", async () => {
		install(
			vi.fn<ReadBinary>(async (_path, maxBytes) =>
				maxBytes === undefined
					? failed("file_too_large", 12_000_000, "video/mp4")
					: ok(new Uint8Array(512), 12_000_000, "video/mp4", true),
			),
		);
		const runtime = { tabId: "remote-tab", command: vi.fn(), stores: new Map() };
		await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<ChatMedia kind="video" path="clip.mp4" />
			</SessionRuntimeProvider>,
		);
		expect(readBinary.mock.calls).toEqual([
			["clip.mp4", 512, "remote-tab"],
			["clip.mp4", undefined, "remote-tab"],
		]);
		expect(container.querySelector("[data-chat-media-too-large='video']")).not.toBeNull();
	});

	it("falls back to the chip when the file does not decode", async () => {
		install(fakeFs({ "odd.mkv": { bytes: WEBM, mime: "video/x-matroska" } }));
		await mount(<ChatMedia kind="video" path="odd.mkv" />);
		const video = container.querySelector("video");
		await act(async () => video?.dispatchEvent(new Event("error")));
		expect(container.querySelector("video")).toBeNull();
		expect(container.querySelector("[data-chat-media-unavailable='video']")?.getAttribute("title")).toContain(
			"Can't play this file here",
		);
	});

	it("opens the file in the Files viewer", async () => {
		install(fakeFs({ "out/demo.webm": { bytes: WEBM, mime: "video/webm" } }));
		await mount(<ChatMedia kind="video" path="out/demo.webm" />);
		const open = container.querySelector("button[aria-label='Open in Files']") as unknown as HTMLButtonElement;
		await act(async () => open.dispatchEvent(new Event("click", { bubbles: true })));
		expect(useUiStore.getState().filePreviewPath).toBe("out/demo.webm");
	});

	it("shares one read between players of the same file and revokes it after the last", async () => {
		install(fakeFs({ "/w/out/demo.webm": { bytes: WEBM, mime: "video/webm" } }));
		const read = { content: [], details: { mediaPath: "/w/out/demo.webm" } };
		await mount(
			<>
				<ToolResultMedia args={{ path: "out/demo.webm" }} result={read} toolName="read" />
				<ChatMedia kind="video" path="/w/out/demo.webm" />
			</>,
		);
		expect(container.querySelectorAll("video")).toHaveLength(2);
		expect(readBinary).toHaveBeenCalledTimes(2);
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		await act(async () => {});
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
	});
});

describe("media in markdown and replies", () => {
	beforeAll(() => preloadMarkdownPipeline());

	const render = (content: string) =>
		renderToStaticMarkup(
			<I18nProvider>
				<MarkdownRenderer content={content} />
			</I18nProvider>,
		);

	it("embeds a local video image as the player and a PDF as a viewer chip", () => {
		const html = parseHTML(`<div>${render("![demo](out/demo.mp4)\n\n![report](docs/report.pdf)")}</div>`).document;
		expect(html.querySelector("[data-chat-media='video']")).not.toBeNull();
		expect(html.querySelector("img")).toBeNull();
		expect(html.querySelector("[data-chat-file='pdf']")?.textContent).toBe("report");
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
								text: "Saved [the demo](out/demo.webm), `out/demo.webm`, `tone.mp3` and [the page](site/index.html).",
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
		expect(list?.querySelector("[data-chat-file='html']")?.textContent).toBe("index.html");
	});
});
