/**
 * Where the chat finds audio, video and documents: stock tool results carry
 * them only as paths (read's mediaPath, write's resolvedPath, tts's saved file,
 * a browser recording's returned path), and replies name them by link or as a
 * quoted path.
 */
import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../stores/tools";
import { workOutcomes } from "../chat/work-view";
import { chatMediaKind, chatReferenceKind, localFilePath, referencedFiles, toolResultMedia } from "./chat-media";

describe("chat media kinds", () => {
	it("follows the Files viewer's extension table", () => {
		expect(chatMediaKind("out/demo.MP4")).toBe("video");
		expect(chatMediaKind("clip.webm")).toBe("video");
		expect(chatMediaKind("voice.mp3")).toBe("audio");
		expect(chatMediaKind("speech.wav")).toBe("audio");
		expect(chatMediaKind("notes.md")).toBeNull();
		expect(chatReferenceKind("report.pdf")).toBe("pdf");
		expect(chatReferenceKind("site/index.html")).toBe("html");
		expect(chatReferenceKind("chart.svg")).toBe("image");
		expect(chatReferenceKind("shot.png")).toBe("image");
		expect(chatReferenceKind("out/Q3.xlsx")).toBe("document");
		expect(chatReferenceKind("deck.PPTX")).toBe("document");
		expect(chatReferenceKind("data/rows.csv")).toBe("document");
		expect(chatReferenceKind("old.doc")).toBe("document");
		expect(chatReferenceKind("src/app.ts")).toBeNull();
	});

	it("reads local paths out of hrefs and leaves web and other schemes alone", () => {
		expect(localFilePath("file:///tmp/my%20clip.mp4")).toBe("/tmp/my clip.mp4");
		expect(localFilePath("out/demo.mp4?t=3#x")).toBe("out/demo.mp4");
		expect(localFilePath("C:\\work\\demo.mp4")).toBe("C:\\work\\demo.mp4");
		expect(localFilePath("https://example.com/demo.mp4")).toBeNull();
		expect(localFilePath("//cdn.example.com/demo.mp4")).toBeNull();
		expect(localFilePath("local://demo.mp4")).toBeNull();
		expect(localFilePath("#demo")).toBeNull();
	});
});

describe("tool result media", () => {
	it("takes stock read's mediaPath for a video or a sound, not for a picture", () => {
		const read = (mediaPath: string) => ({
			content: [{ type: "text", text: "Read video" }],
			details: { mediaPath },
		});
		expect(toolResultMedia("read", { path: "demo.mp4" }, read("/w/demo.mp4"))).toEqual([
			{ path: "/w/demo.mp4", kind: "video" },
		]);
		expect(toolResultMedia("read", { path: "tone.mp3" }, read("/w/tone.mp3"))).toEqual([
			{ path: "/w/tone.mp3", kind: "audio" },
		]);
		expect(toolResultMedia("read", { path: "shot.png" }, read("/w/shot.png"))).toEqual([]);
	});

	it("takes a write's resolved path only when it is media", () => {
		expect(
			toolResultMedia("write", { path: "a.webm" }, { content: [], details: { resolvedPath: "/w/a.webm" } }),
		).toEqual([{ path: "/w/a.webm", kind: "video" }]);
		expect(toolResultMedia("write", { path: "a.ts" }, { content: [], details: { resolvedPath: "/w/a.ts" } })).toEqual(
			[],
		);
	});

	it("takes tts's saved file, which may be a wav in place of the requested mp3", () => {
		const local = {
			content: [
				{ type: "text", text: "Saved 44 bytes to out/hi.wav (voice=k/af, codec=wav, backend=local, 24000 Hz)." },
			],
			details: { bytes: 44, codec: "wav" },
		};
		expect(toolResultMedia("tts", { output_path: "out/hi.mp3" }, local)).toEqual([
			{ path: "out/hi.wav", kind: "audio" },
		]);
		expect(toolResultMedia("tts", { output_path: "out/hi.mp3" }, { content: [], details: {} })).toEqual([
			{ path: "out/hi.mp3", kind: "audio" },
		]);
	});

	it("takes the path a browser run returned from tab.recordStop()", () => {
		const result = {
			content: [{ type: "text", text: "ok" }],
			details: {
				url: "https://example.com",
				value: { path: "/tmp/run.webm", durationMs: 1200, contactSheet: "x.png" },
			},
		};
		expect(toolResultMedia("browser", { code: "…" }, result)).toEqual([{ path: "/tmp/run.webm", kind: "video" }]);
		const nested = { details: { value: { recording: { outputPath: "/tmp/a.mp4" } } } };
		expect(toolResultMedia("browser", {}, nested)).toEqual([{ path: "/tmp/a.mp4", kind: "video" }]);
	});

	it("lists a run's media once in the work outcome, across tools and agents", () => {
		const entry = (toolName: string, args: Record<string, unknown>, details: Record<string, unknown>): ToolEntry => ({
			toolName,
			args,
			status: "done",
			streamingArgs: "",
			isError: false,
			startTime: 1,
			endTime: 2,
			result: { content: [], details },
		});
		const outcome = workOutcomes(
			[
				entry("write", { path: "out/demo.webm" }, { resolvedPath: "/w/out/demo.webm" }),
				{ entry: entry("read", { path: "out/demo.webm" }, { mediaPath: "/w/out/demo.webm" }), agentName: "child" },
				entry("tts", { output_path: "tone.mp3" }, {}),
			],
			undefined,
			"/w",
		);
		expect(outcome.media).toEqual([
			{ path: "/w/out/demo.webm", kind: "video" },
			{ path: "tone.mp3", kind: "audio" },
		]);
	});
});

describe("files a reply names", () => {
	it("finds linked and quoted media and documents, in order, once each", () => {
		const reply = [
			"Rendered [the demo](out/demo.mp4) and the narration `out/voice.mp3`.",
			"The report is [here](<docs/my report.pdf>) and `./out/demo.mp4` again.",
			"See also [site][page].",
			"",
			"[page]: site/index.html",
		].join("\n");
		expect(referencedFiles(reply)).toEqual([
			{ path: "out/demo.mp4", kind: "video" },
			{ path: "out/voice.mp3", kind: "audio" },
			{ path: "docs/my report.pdf", kind: "pdf" },
			{ path: "site/index.html", kind: "html" },
		]);
	});

	it("skips embeds, fenced code, commands, web links and plain files", () => {
		const reply = [
			"![inline](out/inline.mp4) plays in place.",
			"Ran `ffmpeg -i in.mp4 out.mp4` and `rm *.mp4`.",
			"Online: [video](https://example.com/clip.mp4), source `src/app.ts`.",
			"```sh",
			"open `fenced.mp4`",
			"[fenced](fenced.webm)",
			"```",
		].join("\n");
		expect(referencedFiles(reply)).toEqual([]);
	});
});
