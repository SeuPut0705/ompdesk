import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearMentionFiles,
	editFieldText,
	fileToImage,
	IMAGE_MAX_SIDE,
	listMentionFiles,
	MENTION_FILES_TTL_MS,
	mentionToken,
} from "./input-area-utils";

/** FileReader stand-in (Node has none): `readAsDataURL` over the blob's bytes. */
class FakeFileReader {
	result: string | null = null;
	error: Error | null = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(blob: Blob): void {
		void blob.arrayBuffer().then(buffer => {
			this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
			this.onload?.();
		});
	}
}

let bitmapSize = { width: 4000, height: 2000 };
const drawn: { width: number; height: number }[] = [];
const closed = vi.fn();

class FakeOffscreenCanvas {
	constructor(
		readonly width: number,
		readonly height: number,
	) {}
	getContext() {
		return {
			imageSmoothingQuality: "low",
			drawImage: (_bitmap: unknown, _x: number, _y: number, width: number, height: number) =>
				drawn.push({ width, height }),
		};
	}
	async convertToBlob({ type }: { type: string }) {
		return new Blob([new Uint8Array([9, 9])], { type });
	}
}

beforeEach(() => {
	bitmapSize = { width: 4000, height: 2000 };
	drawn.length = 0;
	closed.mockClear();
	vi.stubGlobal("FileReader", FakeFileReader);
	vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => ({ ...bitmapSize, close: closed })),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("fileToImage", () => {
	it("scales a picture larger than the cap down to it, keeping its format", async () => {
		const image = await fileToImage(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
		expect(drawn).toEqual([{ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE / 2 }]);
		expect(image.content).toEqual({ type: "image", data: "CQk=", mimeType: "image/png" });
		expect(image.preview).toBe("data:image/png;base64,CQk=");
		expect(closed).toHaveBeenCalled();
	});

	it("keeps a picture that already fits, and a GIF, byte for byte", async () => {
		bitmapSize = { width: 800, height: 600 };
		const small = await fileToImage(new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
		expect(small.content).toEqual({ type: "image", data: "AQID", mimeType: "image/jpeg" });
		bitmapSize = { width: 4000, height: 4000 };
		const gif = await fileToImage(new File([new Uint8Array([1, 2, 3])], "a.gif", { type: "image/gif" }));
		expect(gif.content.mimeType).toBe("image/gif");
		expect(drawn).toEqual([]);
	});
});

describe("mentionToken", () => {
	it("reads Hangul and other non-ASCII names, as stock's @ token does", () => {
		expect(mentionToken("see @문")).toEqual({ start: 4, query: "문", quoted: false });
		expect(mentionToken("@résumé.md")).toEqual({ start: 0, query: "résumé.md", quoted: false });
	});

	it("reads an open quote as a path with spaces, and ends at stock's delimiters", () => {
		expect(mentionToken('open @"My Re')).toEqual({ start: 5, query: "My Re", quoted: true });
		expect(mentionToken('open @"My Report.md" ')).toBeNull();
		expect(mentionToken("a@b")).toBeNull();
		expect(mentionToken("@a b")).toBeNull();
	});
});

describe("listMentionFiles", () => {
	const tree = (...paths: string[]) => ({
		ok: true,
		entries: paths.map(path => ({ kind: "file", path, name: path })),
	});
	afterEach(() => clearMentionFiles());

	it("walks again once its listing is old, so files created since show up", async () => {
		const list = vi.fn().mockResolvedValueOnce(tree("a.ts")).mockResolvedValueOnce(tree("a.ts", "new.ts"));
		vi.stubGlobal("window", { omp: { fs: { list } } });
		expect(await listMentionFiles("/w", "t1", 1000)).toEqual(["a.ts"]);
		expect(await listMentionFiles("/w", "t1", 1000 + MENTION_FILES_TTL_MS - 1)).toEqual(["a.ts"]);
		expect(list).toHaveBeenCalledTimes(1);
		expect(await listMentionFiles("/w", "t1", 1000 + MENTION_FILES_TTL_MS)).toEqual(["a.ts", "new.ts"]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("never remembers a failed walk: the next @ tries again", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, error: "busy" })
			.mockRejectedValueOnce(new Error("ipc"))
			.mockResolvedValueOnce(tree("a.ts"));
		vi.stubGlobal("window", { omp: { fs: { list } } });
		expect(await listMentionFiles("/w", "t1", 1000)).toEqual([]);
		expect(await listMentionFiles("/w", "t1", 1001)).toEqual([]);
		expect(await listMentionFiles("/w", "t1", 1002)).toEqual(["a.ts"]);
		expect(list).toHaveBeenCalledTimes(3);
	});
});

describe("editFieldText", () => {
	/** A focused field whose browser applies `insertText`/`delete` to its selection and records each edit. */
	function field(value: string, focused = true) {
		const edits: { command: string; from: number; to: number; text?: string }[] = [];
		const el = {
			value,
			selectionStart: 0,
			selectionEnd: 0,
			setSelectionRange(start: number, end: number) {
				el.selectionStart = start;
				el.selectionEnd = end;
			},
			ownerDocument: {
				activeElement: null as unknown,
				execCommand(command: string, _ui: boolean, text = "") {
					edits.push({ command, from: el.selectionStart, to: el.selectionEnd, text });
					el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
					return true;
				},
			},
		};
		if (focused) el.ownerDocument.activeElement = el;
		return { el: el as unknown as HTMLTextAreaElement, edits };
	}

	it("replaces only the changed middle as one native edit", () => {
		const { el, edits } = field("Run /re now");
		expect(editFieldText(el, "Run /retry now")).toBe(true);
		expect(el.value).toBe("Run /retry now");
		expect(edits).toEqual([{ command: "insertText", from: 7, to: 7, text: "try" }]);
	});

	it("deletes a removed span and never splits an emoji", () => {
		const removed = field("a @x.md b");
		expect(editFieldText(removed.el, "a  b")).toBe(true);
		expect(removed.edits[0]).toMatchObject({ command: "delete", from: 2, to: 7 });
		const emoji = field("a😀");
		expect(editFieldText(emoji.el, "a😁")).toBe(true);
		expect(emoji.edits[0]).toMatchObject({ from: 1, to: 3, text: "😁" });
	});

	it("leaves a field without focus to the caller", () => {
		const { el, edits } = field("draft", false);
		expect(editFieldText(el, "other")).toBe(false);
		expect(edits).toEqual([]);
		expect(el.value).toBe("draft");
	});
});
