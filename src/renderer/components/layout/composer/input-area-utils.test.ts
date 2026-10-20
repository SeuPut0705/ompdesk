import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearMentionFiles,
	editFieldText,
	fileToImage,
	IMAGE_MAX_SIDE,
	listMentionFiles,
	MENTION_FILES_TTL_MS,
	MENTION_FS_DEPTH,
	MENTION_FS_MAX_ENTRIES,
	mentionDirOf,
	mentionListingOf,
	mentionToken,
	searchMentionFiles,
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

	it("sends a picture as it was where the browser has no OffscreenCanvas or cannot decode it", async () => {
		vi.stubGlobal("OffscreenCanvas", undefined);
		const withoutCanvas = await fileToImage(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
		expect(withoutCanvas.content).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
		vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => {
				throw new Error("cannot decode");
			}),
		);
		const undecodable = await fileToImage(new File([new Uint8Array([1, 2, 3])], "b.jpg", { type: "image/jpeg" }));
		expect(undecodable.content).toEqual({ type: "image", data: "AQID", mimeType: "image/jpeg" });
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

	it("asks for a deep, large listing and flags a walk main cut at its cap", async () => {
		const list = vi.fn().mockResolvedValue({ ...tree("a.ts"), truncated: true });
		vi.stubGlobal("window", { omp: { fs: { list } } });
		const paths = await listMentionFiles("/w", "t1", 1000);
		expect(list).toHaveBeenCalledWith(undefined, MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES, "t1");
		expect(MENTION_FS_MAX_ENTRIES).toBeGreaterThan(2335);
		expect(MENTION_FS_DEPTH).toBeGreaterThan(8);
		expect(mentionListingOf(paths)?.truncated).toBe(true);
		expect(mentionListingOf(paths)?.nfc).toEqual(["a.ts"]);
		clearMentionFiles();
		list.mockResolvedValue(tree("a.ts"));
		expect(mentionListingOf(await listMentionFiles("/w", "t1", 5000))?.truncated).toBe(false);
	});

	it("keeps NFC twins of decomposed names next to the names to insert", async () => {
		const decomposed = "한글.md".normalize("NFD");
		vi.stubGlobal("window", { omp: { fs: { list: vi.fn().mockResolvedValue(tree(decomposed)) } } });
		const paths = await listMentionFiles("/w", null, 1000);
		expect(paths).toEqual([decomposed]);
		expect(mentionListingOf(paths)?.nfc).toEqual(["한글.md"]);
	});

	it("lists a folder of a cut walk on its own, once, and keeps only the files the walk missed", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ ...tree("pkg/a.ts"), truncated: true })
			.mockResolvedValueOnce(tree("pkg/a.ts", "pkg/deep/needle.ts", "pkg/deep/zed.ts"));
		vi.stubGlobal("window", { omp: { fs: { list } } });
		const listing = mentionListingOf(await listMentionFiles("/w", "t1", 1000));
		expect(listing?.dir("pkg")).toBeUndefined();
		await Promise.all([listing?.loadDir("pkg"), listing?.loadDir("pkg")]);
		expect(list).toHaveBeenCalledTimes(2);
		expect(list).toHaveBeenLastCalledWith("pkg", MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES, "t1");
		expect(listing?.dir("pkg")).toEqual({ extra: ["pkg/deep/needle.ts", "pkg/deep/zed.ts"], truncated: false });
	});

	it("remembers a failed folder listing as an incomplete one, so the menu never loops on it", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ ...tree("a.ts"), truncated: true })
			.mockRejectedValueOnce(new Error("ipc"));
		vi.stubGlobal("window", { omp: { fs: { list } } });
		const listing = mentionListingOf(await listMentionFiles("/w", "t1", 1000));
		await listing?.loadDir("pkg");
		expect(listing?.dir("pkg")).toEqual({ extra: [], truncated: true });
	});
});

describe("mentionDirOf", () => {
	it("names the folder part of a typed path", () => {
		expect(mentionDirOf("src/ren")).toBe("src");
		expect(mentionDirOf("a/b/c.ts")).toBe("a/b");
		expect(mentionDirOf("./pkg/deep/ne")).toBe("pkg/deep");
		expect(mentionDirOf("pkg/")).toBe("pkg");
	});

	it("has none for a bare name, an absolute path or a path that leaves the workspace", () => {
		expect(mentionDirOf("needle")).toBeNull();
		expect(mentionDirOf("/etc/hosts")).toBeNull();
		expect(mentionDirOf("../x/y")).toBeNull();
		expect(mentionDirOf("a//b")).toBeNull();
		expect(mentionDirOf("")).toBeNull();
	});
});

describe("searchMentionFiles", () => {
	const source = (...paths: string[]) => ({ paths, nfc: paths.map(path => path.normalize("NFC")) });

	it("returns the best files with their spans, and how many matched in all", () => {
		const { matches, total } = searchMentionFiles(
			"app",
			[source("e2e/app-auto-update.e2e.ts", "src/renderer/App.tsx", "docs/readme.md")],
			1,
		);
		expect(total).toBe(2);
		expect(matches).toEqual([{ path: "src/renderer/App.tsx", label: "src/renderer/App.tsx", ranges: [[13, 16]] }]);
	});

	it("labels with the NFC name and inserts the name as it is on disk", () => {
		const decomposed = "docs/한글.md".normalize("NFD");
		const { matches } = searchMentionFiles("ㅎㄱ", [source(decomposed)]);
		expect(matches).toEqual([{ path: decomposed, label: "docs/한글.md", ranges: [[5, 7]] }]);
	});

	it("ranks across several sources and lists the shortest paths for an empty query", () => {
		const { matches, total } = searchMentionFiles("", [source("a/b/c.ts", "z.ts"), source("a/d.ts")]);
		expect(total).toBe(3);
		expect(matches.map(match => match.path)).toEqual(["z.ts", "a/d.ts", "a/b/c.ts"]);
	});

	it("finds a file in a list the size of a real repository (2 335+ files) by a long path or by name", () => {
		const paths: string[] = [];
		for (let pkg = 0; pkg < 25; pkg++) for (let file = 0; file < 100; file++) paths.push(`pkg${pkg}/file-${file}.ts`);
		paths.push("a-first/needle-early.ts", "zz-last/needle-file.ts", "d/e/f/g/h/i/j/k/l/m/deep-file.ts");
		const all = source(...paths);
		expect(searchMentionFiles("needle-file", [all]).matches[0]?.path).toBe("zz-last/needle-file.ts");
		expect(searchMentionFiles("deep-file", [all]).matches[0]?.path).toBe("d/e/f/g/h/i/j/k/l/m/deep-file.ts");
		// Both reach the top, whatever their folder: nothing is hidden behind the 2 500 `pkg##` files.
		expect(
			searchMentionFiles("needle", [all])
				.matches.map(match => match.path)
				.sort(),
		).toEqual(["a-first/needle-early.ts", "zz-last/needle-file.ts"]);
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
