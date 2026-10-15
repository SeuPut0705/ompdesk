import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listDirectories,
	listWorkspace,
	mutateWorkspace,
	readWorkspaceBinary,
	readWorkspaceImage,
	sniffMime,
	statWorkspacePath,
} from "./workspace-fs";

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));
/** A file's leading bytes followed by filler, so nothing depends on the exact header length. */
const fileOf = (head: readonly number[], length = 64) => {
	const bytes = new Uint8Array(Math.max(length, head.length));
	bytes.set(head);
	return bytes;
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP = [...ascii("PK"), 3, 4];

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workspace-fs-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("sniffMime", () => {
	it.each([
		["doc.bin", ascii("%PDF-1.7"), "application/pdf"],
		["pic.bin", PNG, "image/png"],
		["pic.bin", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
		["pic.bin", ascii("GIF89a"), "image/gif"],
		["pic.bin", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")], "image/webp"],
		["clip.bin", [0, 0, 0, 0x18, ...ascii("ftypisom")], "video/mp4"],
		["clip.bin", [0, 0, 0, 0x14, ...ascii("ftypqt  ")], "video/quicktime"],
		["clip.bin", [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...ascii("webm")], "video/webm"],
		["clip.bin", [0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88, ...ascii("matroska")], "video/x-matroska"],
		["song.bin", ascii("ID3"), "audio/mpeg"],
		["song.bin", [0xff, 0xfb, 0x90, 0x64], "audio/mpeg"],
		["song.bin", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")], "audio/wav"],
		["song.bin", ascii("OggS"), "audio/ogg"],
		["song.bin", ascii("fLaC"), "audio/flac"],
		["report.docx", ZIP, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["sheet.XLSX", ZIP, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
		["deck.pptx", ZIP, "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
		["bundle.bin", ZIP, "application/zip"],
		["logs.bin", [0x1f, 0x8b, 0x08], "application/gzip"],
		["app.bin", ascii("SQLite format 3\0"), "application/vnd.sqlite3"],
	])("%s starting %j is %s", (name, head, mime) => {
		expect(sniffMime(fileOf(head), name)).toBe(mime);
	});

	it("trusts the bytes over the extension, refining only within a container family", () => {
		expect(sniffMime(fileOf(PNG), "notes.pdf")).toBe("image/png");
		expect(sniffMime(fileOf(ZIP), "notes.mp3")).toBe("application/zip");
		expect(sniffMime(fileOf([0, 0, 0, 0x18, ...ascii("ftypisom")]), "voice.m4a")).toBe("audio/mp4");
		expect(sniffMime(fileOf(ascii("OggS")), "clip.ogv")).toBe("video/ogg");
	});

	it("falls back to the extension, then to octet-stream", () => {
		expect(sniffMime(fileOf(ascii("no magic here")), "track.aac")).toBe("audio/aac");
		expect(sniffMime(fileOf(ascii("no magic here")), "Movie.MKV")).toBe("video/x-matroska");
		expect(sniffMime(fileOf(ascii("no magic here")), "data.bin")).toBe("application/octet-stream");
		expect(sniffMime(new Uint8Array(0), "empty")).toBe("application/octet-stream");
	});
});

describe("readWorkspaceBinary", () => {
	it("returns the whole file as a plain Uint8Array with its sniffed type", async () => {
		const bytes = fileOf(ascii("%PDF-1.4\n%binary"), 300);
		bytes[200] = 0;
		bytes[201] = 0xff;
		writeFileSync(join(root, "paper.pdf"), bytes);
		const result = await readWorkspaceBinary(root, { path: "paper.pdf" });
		expect(result).toMatchObject({ ok: true, mime: "application/pdf", size: 300, truncated: false });
		expect(result.data).toEqual(bytes);
		expect(result.data.byteLength).toBe(result.data.buffer.byteLength);
	});

	it("refuses a file over the cap with file_too_large, its size and type", async () => {
		writeFileSync(join(root, "big.png"), fileOf(PNG, 4096));
		const result = await readWorkspaceBinary(root, { path: "big.png" }, 1024);
		expect(result).toMatchObject({
			ok: false,
			code: "file_too_large",
			size: 4096,
			mime: "image/png",
			truncated: false,
		});
		expect(result.data).toHaveLength(0);
		// A maxBytes at or above the cap is not a prefix request: still too large.
		await expect(readWorkspaceBinary(root, { path: "big.png", maxBytes: 5000 }, 1024)).resolves.toMatchObject({
			ok: false,
			code: "file_too_large",
		});
	});

	it("hands back a prefix for an explicit small maxBytes", async () => {
		const bytes = fileOf(PNG, 4096);
		bytes.fill(7, PNG.length);
		writeFileSync(join(root, "big.png"), bytes);
		const result = await readWorkspaceBinary(root, { path: "big.png", maxBytes: 100 }, 1024);
		expect(result).toMatchObject({ ok: true, mime: "image/png", size: 4096, truncated: true });
		expect(result.data).toEqual(bytes.slice(0, 100));
		// A file that fits the prefix is whole.
		writeFileSync(join(root, "small.png"), bytes.subarray(0, 50));
		await expect(readWorkspaceBinary(root, { path: "small.png", maxBytes: 100 })).resolves.toMatchObject({
			ok: true,
			size: 50,
			truncated: false,
		});
	});

	it("keeps relative paths inside the workspace and reports coded failures", async () => {
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "sub"), { recursive: true });
		writeFileSync(join(root, "outside.bin"), fileOf(PNG));
		await expect(readWorkspaceBinary(workspace, { path: "../outside.bin" })).resolves.toMatchObject({
			ok: false,
			code: "path_escapes_workspace",
		});
		await expect(readWorkspaceBinary(workspace, { path: "sub/../../outside.bin" })).resolves.toMatchObject({
			ok: false,
			code: "path_escapes_workspace",
		});
		await expect(readWorkspaceBinary(null, { path: "outside.bin" })).resolves.toMatchObject({
			ok: false,
			code: "no_workspace",
		});
		await expect(readWorkspaceBinary(workspace, { path: "missing.bin" })).resolves.toMatchObject({
			ok: false,
			code: "file_not_found",
		});
		await expect(readWorkspaceBinary(workspace, { path: "sub" })).resolves.toMatchObject({
			ok: false,
			code: "not_a_file",
		});
		await expect(readWorkspaceBinary(workspace, { path: "" })).resolves.toMatchObject({
			ok: false,
			code: "invalid_path",
		});
	});
});

describe("readWorkspaceImage", () => {
	it("still accepts only image signatures", async () => {
		writeFileSync(join(root, "pic.png"), fileOf(PNG));
		writeFileSync(join(root, "paper.png"), fileOf(ascii("%PDF-1.4")));
		await expect(readWorkspaceImage(root, { path: "pic.png" })).resolves.toMatchObject({
			ok: true,
			mime: "image/png",
		});
		await expect(readWorkspaceImage(root, { path: "paper.png" })).resolves.toMatchObject({
			ok: false,
			code: "unsupported_image",
		});
	});
});

describe("natural name order", () => {
	it("lists numbered names by their number, directories first", async () => {
		for (const name of ["file-10.txt", "file-2.txt", "file-1.txt", "Notes.md"]) writeFileSync(join(root, name), "");
		for (const name of ["step-10", "step-9"]) mkdirSync(join(root, name));
		const result = await listWorkspace(root, {});
		expect(result.entries.map(entry => entry.name)).toEqual([
			"step-9",
			"step-10",
			"file-1.txt",
			"file-2.txt",
			"file-10.txt",
			"Notes.md",
		]);
		expect((await listDirectories(root)).entries.map(entry => entry.name)).toEqual(["step-9", "step-10"]);
	});
});

describe("Files panel writes", () => {
	const trashed: string[] = [];
	const trash = async (abs: string) => {
		trashed.push(abs);
		rmSync(abs, { recursive: true, force: true });
	};
	it("creates, renames and trashes inside the workspace and never overwrites", async () => {
		mkdirSync(join(root, "src"));
		expect(await mutateWorkspace(root, { op: "createFile", parent: "src", name: "a.ts" }, trash)).toEqual({
			ok: true,
			path: "src/a.ts",
		});
		expect(await mutateWorkspace(root, { op: "createFolder", parent: "", name: "docs" }, trash)).toEqual({
			ok: true,
			path: "docs",
		});
		expect(await mutateWorkspace(root, { op: "createFile", parent: "src", name: "a.ts" }, trash)).toMatchObject({
			ok: false,
			code: "exists",
		});
		writeFileSync(join(root, "src", "b.ts"), "keep");
		expect(await mutateWorkspace(root, { op: "rename", path: "src/a.ts", name: "b.ts" }, trash)).toMatchObject({
			ok: false,
			code: "exists",
		});
		expect(await mutateWorkspace(root, { op: "rename", path: "src/a.ts", name: "c.ts" }, trash)).toEqual({
			ok: true,
			path: "src/c.ts",
		});
		expect(await mutateWorkspace(root, { op: "trash", path: "src/c.ts" }, trash)).toEqual({
			ok: true,
			path: "src/c.ts",
		});
		expect(trashed).toEqual([join(root, "src", "c.ts")]);
		expect((await listWorkspace(root, {})).entries.map(entry => entry.path)).toEqual(["docs", "src"]);
	});
	it("refuses escapes, the root itself, bad names and malformed requests", async () => {
		for (const [request, code] of [
			[{ op: "createFile", parent: "..", name: "x" }, "path_escapes_workspace"],
			[{ op: "createFile", parent: "", name: "../x" }, "invalid_name"],
			[{ op: "createFile", parent: "", name: ".." }, "invalid_name"],
			[{ op: "createFile", parent: "", name: " x" }, "invalid_name"],
			[{ op: "trash", path: "" }, "invalid_path"],
			[{ op: "trash", path: "missing.txt" }, "file_not_found"],
			[{ op: "rename", path: "../outside", name: "x" }, "path_escapes_workspace"],
			[{ op: "delete", path: "a" }, "invalid_path"],
		] as const) {
			expect(await mutateWorkspace(root, request, trash)).toMatchObject({ ok: false, code });
		}
		expect(await mutateWorkspace(null, { op: "trash", path: "a" }, trash)).toMatchObject({ code: "no_workspace" });
	});
	it("writes an edited file in place only while it is unchanged on disk, unless forced", async () => {
		const file = join(root, "notes.md");
		writeFileSync(file, "old");
		if (process.platform !== "win32") chmodSync(file, 0o640);
		const loaded = statSync(file).mtimeMs;
		const saved = await mutateWorkspace(
			root,
			{ op: "write", path: "notes.md", content: "new ✓", expectedMtimeMs: loaded },
			trash,
		);
		expect(saved).toMatchObject({ ok: true, path: "notes.md", mtimeMs: statSync(file).mtimeMs });
		expect(readFileSync(file, "utf8")).toBe("new ✓");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);

		// The editor still holds the first time: someone else's write in between is not overwritten.
		const stale = await mutateWorkspace(
			root,
			{ op: "write", path: "notes.md", content: "mine", expectedMtimeMs: loaded - 1000 },
			trash,
		);
		expect(stale).toMatchObject({ ok: false, code: "changed_on_disk" });
		expect(readFileSync(file, "utf8")).toBe("new ✓");
		expect(
			await mutateWorkspace(
				root,
				{ op: "write", path: "notes.md", content: "mine", expectedMtimeMs: 0, force: true },
				trash,
			),
		).toMatchObject({ ok: true });
		expect(readFileSync(file, "utf8")).toBe("mine");
	});
	it("refuses to write a folder, a missing file, an escape, a link out of the project or too much text", async () => {
		mkdirSync(join(root, "dir"));
		const outsideDir = mkdtempSync(join(tmpdir(), "workspace-fs-outside-"));
		writeFileSync(join(outsideDir, "secret.txt"), "keep");
		writeFileSync(join(root, "big.txt"), "x");
		try {
			const write = (path: string, content = "x") => ({
				op: "write",
				path,
				content,
				expectedMtimeMs: 0,
				force: true,
			});
			expect(await mutateWorkspace(root, write("dir"), trash)).toMatchObject({ ok: false, code: "not_a_file" });
			expect(await mutateWorkspace(root, write("gone.txt"), trash)).toMatchObject({ code: "file_not_found" });
			expect(await mutateWorkspace(root, write("../x"), trash)).toMatchObject({ code: "path_escapes_workspace" });
			if (process.platform !== "win32") {
				symlinkSync(join(outsideDir, "secret.txt"), join(root, "link.txt"));
				expect(await mutateWorkspace(root, write("link.txt"), trash)).toMatchObject({
					code: "path_escapes_workspace",
				});
				expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("keep");
			}
			expect(await mutateWorkspace(root, write("big.txt", "x".repeat(2_000_001)), trash)).toMatchObject({
				code: "file_too_large",
			});
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});
	it("stats a file and reports a missing one", async () => {
		writeFileSync(join(root, "a.txt"), "abc");
		expect(await statWorkspacePath(root, "a.txt")).toMatchObject({ ok: true, size: 3, directory: false });
		expect(await statWorkspacePath(root, ".")).toMatchObject({ ok: true, directory: true });
		expect(await statWorkspacePath(root, "gone.txt")).toMatchObject({ ok: false, code: "file_not_found" });
	});
});
