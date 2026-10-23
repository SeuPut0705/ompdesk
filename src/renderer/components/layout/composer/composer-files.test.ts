import { describe, expect, it } from "vitest";
import { fileMentionFor, fileTextAttachment, intakeComposerFiles } from "./composer-files";

describe("fileMentionFor", () => {
	it("makes paths inside the session folder relative", () => {
		expect(fileMentionFor("/work/app/src/a.ts", "/work/app")).toBe("@src/a.ts");
		expect(fileMentionFor("/work/app/src/a.ts", "/work/app/")).toBe("@src/a.ts");
	});

	it("keeps paths outside the session folder absolute", () => {
		expect(fileMentionFor("/work/application/a.ts", "/work/app")).toBe("@/work/application/a.ts");
		expect(fileMentionFor("/Users/me/Downloads/spec.pdf", "/work/app")).toBe("@/Users/me/Downloads/spec.pdf");
	});

	it("quotes paths stock's unquoted @mention would cut short", () => {
		expect(fileMentionFor("/Users/me/My Report.docx", "/work")).toBe('@"/Users/me/My Report.docx"');
		expect(fileMentionFor("/work/notes (1)", "/work")).toBe('@"notes (1)"');
		expect(fileMentionFor("/work/v1.", "/work")).toBe('@"v1."');
		expect(fileMentionFor('/work/say "hi".txt', "/work")).toBe(`@'say "hi".txt'`);
	});

	it("compares Windows paths without case or separator differences", () => {
		expect(fileMentionFor("C:\\Users\\Me\\Repo\\src\\a.ts", "c:/users/me/repo")).toBe("@src\\a.ts");
		expect(fileMentionFor("D:\\other\\b.xlsx", "C:\\Users\\Me\\Repo")).toBe("@D:\\other\\b.xlsx");
	});
});

describe("intakeComposerFiles", () => {
	/** Never called unless a test says so: a file with a path, a text or a refusal never goes to the computer. */
	const unsent = async (file: File): Promise<string> => {
		throw new Error(`${file.name} should not have been sent`);
	};
	const local = (paths: Record<string, string>) => ({
		cwd: "/work",
		pathFor: (file: File) => paths[file.name] ?? "",
		remote: false,
		sendToHost: unsent,
	});

	it("attaches images and mentions every other local file or folder by path", async () => {
		const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		const pdf = new File([new Uint8Array([37, 80, 68, 70, 0])], "spec.pdf", { type: "application/pdf" });
		const folder = new File([], "src");
		const intake = await intakeComposerFiles([png, pdf, folder], {
			...local({ "shot.png": "/work/shot.png", "spec.pdf": "/tmp/spec.pdf", src: "/work/src" }),
			// A dropped folder reaches the page as a file of zero bytes: only the drop's entries tell it apart.
			directories: new Set([folder]),
		});
		expect(intake.images).toEqual([png]);
		expect(intake.mentions).toEqual(["@/tmp/spec.pdf", "@src"]);
		expect(intake.texts).toEqual([]);
		expect(intake.rejected).toEqual([]);
	});

	it("says a folder cannot reach a tab on another computer, never that it is empty", async () => {
		const folder = new File([], "src");
		const sent: string[] = [];
		const intake = await intakeComposerFiles([folder], {
			...local({}),
			remote: true,
			directories: new Set([folder]),
			sendToHost: async (file: File) => {
				sent.push(file.name);
				return "/host/src";
			},
		});
		expect(intake.rejected).toEqual([{ name: "src", reason: "remoteFolder" }]);
		expect(intake.mentions).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("inlines the text of a file without a path and saves any other kind on this computer, refusing only an empty one", async () => {
		const note = new File(["hello\nworld"], "note.md", { type: "text/markdown" });
		const empty = new File([], "empty.txt", { type: "text/plain" });
		const blob = new File([new Uint8Array([1, 0, 2])], "blob.bin");
		const pdf = new File(["%PDF-1.7\n"], "spec.pdf", { type: "application/pdf" });
		const saved: string[] = [];
		const intake = await intakeComposerFiles([note, empty, blob, pdf], {
			...local({}),
			sendToHost: async file => {
				saved.push(file.name);
				return `/up/this-computer/1/${file.name}`;
			},
		});
		expect(saved).toEqual(["blob.bin", "spec.pdf"]);
		expect(intake.mentions).toEqual(["@/up/this-computer/1/blob.bin", "@/up/this-computer/1/spec.pdf"]);
		expect(intake.texts).toEqual([{ name: "note.md", content: "hello\nworld" }]);
		expect(intake.rejected).toEqual([{ name: "empty.txt", reason: "empty" }]);
	});

	it("attaches a picture it cannot read as one as a file, and an SVG as the text it is", async () => {
		const heic = new File([new Uint8Array([0, 0, 0, 24])], "photo.heic", { type: "image/heic" });
		const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
		const intake = await intakeComposerFiles([heic, svg], {
			...local({ "photo.heic": "/Users/me/photo.heic", "logo.svg": "/work/logo.svg" }),
			asFiles: new Set([heic]),
		});
		expect(intake.images).toEqual([]);
		expect(intake.mentions).toEqual(["@/Users/me/photo.heic", "@logo.svg"]);
	});

	it("refuses an empty file with a path as it refuses an empty pasted one, and folds the same file twice", async () => {
		const empty = new File([], "empty.txt");
		const first = new File(["a"], "a.md");
		const again = new File(["a"], "a.md");
		const intake = await intakeComposerFiles(
			[empty, first, again],
			local({ "empty.txt": "/tmp/empty.txt", "a.md": "/tmp/a.md" }),
		);
		expect(intake.rejected).toEqual([{ name: "empty.txt", reason: "empty" }]);
		expect(intake.mentions).toEqual(["@/tmp/a.md"]);
		expect(intake.duplicates).toBe(1);
	});

	it("sends a remote tab's binary file to the computer the tab runs on and mentions its path there", async () => {
		const code = new File(["const a = 1;\n"], "a.ts");
		const docx = new File([new Uint8Array([80, 75, 3, 4, 0])], "계약서 수정.docx");
		// A PDF whose head holds no NUL is still a document, never pasted as its source.
		const pdf = new File(["%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n"], "spec.pdf", {
			type: "application/pdf",
		});
		const sent: string[] = [];
		const intake = await intakeComposerFiles([code, docx, pdf], {
			// This machine's own paths never reach the other computer.
			...local({ "a.ts": "/work/a.ts", "계약서 수정.docx": "/Users/me/계약서 수정.docx" }),
			cwd: "C:\\Users\\admin\\repo",
			remote: true,
			sendToHost: async file => {
				sent.push(file.name);
				if (file.name === "spec.pdf") throw new Error("spec.pdf is too large to send to Windows PC (up to 10 MB).");
				return `C:\\Users\\admin\\AppData\\Roaming\\ompdesk\\web-uploads\\mac\\1\\${file.name}`;
			},
		});
		expect(sent).toEqual(["계약서 수정.docx", "spec.pdf"]);
		expect(intake.texts).toEqual([{ name: "a.ts", content: "const a = 1;\n" }]);
		expect(intake.mentions).toEqual([
			'@"C:\\Users\\admin\\AppData\\Roaming\\ompdesk\\web-uploads\\mac\\1\\계약서 수정.docx"',
		]);
		expect(intake.rejected).toEqual([
			{ name: "spec.pdf", reason: "notSent", message: "spec.pdf is too large to send to Windows PC (up to 10 MB)." },
		]);
	});

	it("refuses a file whose upload failed with why, and never inlines it instead (a web page)", async () => {
		const notes = new File(["hello\n"], "notes.txt", { type: "text/plain" });
		const pdf = new File([new Uint8Array([37, 80, 68, 70])], "spec.pdf", { type: "application/pdf" });
		const intake = await intakeComposerFiles([notes, pdf], {
			cwd: "/work",
			remote: false,
			sendToHost: unsent,
			pathFor: async file => {
				if (file.name === "spec.pdf") throw new Error("Couldn't send spec.pdf to your computer.");
				return "/up/dev/1/notes.txt";
			},
		});
		expect(intake.mentions).toEqual(["@/up/dev/1/notes.txt"]);
		expect(intake.texts).toEqual([]);
		expect(intake.rejected).toEqual([
			{ name: "spec.pdf", reason: "notSent", message: "Couldn't send spec.pdf to your computer." },
		]);
	});

	it("wraps file text in a named attachment block", () => {
		expect(fileTextAttachment('a "b".txt', "x")).toBe(`<attachment name="a 'b'.txt">\nx\n</attachment>`);
	});
});
