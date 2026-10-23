/**
 * Files handed to the composer (picker, OS drag-and-drop, clipboard): images
 * attach as image content, every other file or folder becomes an `@path`
 * mention that stock omp resolves at send time (`utils/file-mentions.ts`:
 * text files and folder listings are inlined, PDF/Office and other binaries
 * are named so the agent opens them with its read tool, which converts them
 * through markit). A web page's path is the file's upload on the computer; an
 * upload that failed is refused with its reason. A file the tab's machine
 * cannot reach by path (a remote tab, or a clipboard blob without a path)
 * falls back to its text, wrapped like a pasted attachment; a remote tab's
 * binary or oversized file is sent to the computer the tab runs on (this one
 * for a pathless file of a local tab) and named by its path there; anything
 * else is refused with a reason. A picture that cannot be read as one (a
 * format the composer cannot draw, a damaged file) is attached as a file.
 */

/** Stock auto-read ceiling for a mentioned text file (`MAX_AUTO_READ_TEXT_BYTES`). */
export const MAX_INLINE_TEXT_BYTES = 5 * 1024 * 1024;
/**
 * Pictures one message should carry. Neither stock omp nor the providers' APIs publish one number for every model,
 * so this is the point past which the composer warns (it never blocks): a request with more pictures than a
 * provider's per-message cap fails there, after the user hit send.
 */
export const MAX_COMPOSER_IMAGES = 20;
/** Bytes sniffed for a NUL to tell text from binary (stock `isProbablyBinary` reads a head too). */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Documents stock reads through its read tool (markit), never as their bytes: a PDF can hold no NUL in its first
 * 8,000 bytes and would read as text. A remote tab sends them to its computer whatever their head looks like.
 */
const DOCUMENT_EXTENSIONS = new Set([
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"odp",
	"rtf",
	"epub",
	"hwp",
	"hwpx",
]);

function isDocument(file: File): boolean {
	const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
	return file.type === "application/pdf" || (extension !== undefined && DOCUMENT_EXTENSIONS.has(extension));
}

export type ComposerFileRejection = "empty" | "unreadable" | "notSent" | "remoteFolder";

export interface ComposerFileIntake {
	images: File[];
	/** Ready-to-insert mention tokens (`@src/a.ts`, `@"/Users/me/My Report.pdf"`). */
	mentions: string[];
	/** Text of files that could not be referenced by path. */
	texts: Array<{ name: string; content: string }>;
	/** `message`: why a `notSent` file did not reach the computer, in words (the upload's error). */
	rejected: Array<{ name: string; reason: ComposerFileRejection; message?: string }>;
	/** Files that named a path already in this batch. */
	duplicates: number;
}

export interface ComposerFileIntakeOptions {
	/** Session cwd: paths inside it become relative mentions. */
	cwd: string;
	/**
	 * Absolute path of a dropped/picked file on this machine (a web page: its upload's path on the host); "" when
	 * it has none. Rejects when the file could not be sent there (a web page's upload failed), with why.
	 */
	pathFor: (file: File) => string | Promise<string>;
	/** The tab's omp runs on another device, so this machine's paths mean nothing there. */
	remote: boolean;
	/**
	 * A file with no path the tab's computer can read that is no text to inline (a .docx, a PDF, a binary, a text
	 * over the inline cap): sends it to the computer the tab runs on, a paired host or this one, and answers its path
	 * there. Rejects with why it was not sent, in words.
	 */
	sendToHost: (file: File) => Promise<string>;
	/** The files that are folders: a drop reports one as a file of zero bytes, which is no reason to refuse it. */
	directories?: ReadonlySet<File>;
	/** Pictures that could not be read as one: they go the way of any other file (a mention, or sent). */
	asFiles?: ReadonlySet<File>;
}

/** An SVG is text the agent reads (a picture attachment of it is no format any provider takes). */
function attachesAsImage(file: File, options: ComposerFileIntakeOptions): boolean {
	return file.type.startsWith("image/") && file.type !== "image/svg+xml" && options.asFiles?.has(file) !== true;
}

const LEADING_PUNCTUATION = /^[`"'([{<]/;
const TRAILING_PUNCTUATION = /[)\]}>.,;:!?"'`]$/;

/**
 * `@` mention for a local path: relative inside `cwd`, absolute outside it;
 * quoted whenever stock's unquoted form (`@([^\s@]+)`, punctuation trimmed)
 * would cut it short.
 */
export function fileMentionFor(path: string, cwd: string): string {
	const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
	const comparable = (value: string) => (windows ? value.replace(/\\/g, "/").toLowerCase() : value);
	const base = cwd.replace(/[\\/]+$/, "");
	const target = base && comparable(path).startsWith(`${comparable(base)}/`) ? path.slice(base.length + 1) : path;
	const needsQuotes = /[\s@]/.test(target) || LEADING_PUNCTUATION.test(target) || TRAILING_PUNCTUATION.test(target);
	if (!needsQuotes) return `@${target}`;
	return target.includes('"') ? `@'${target}'` : `@"${target}"`;
}

async function readText(file: File): Promise<string | "empty" | "tooLarge" | "binary" | "unreadable"> {
	if (file.size === 0) return "empty";
	if (file.size > MAX_INLINE_TEXT_BYTES) return "tooLarge";
	try {
		const head = new Uint8Array(await file.slice(0, BINARY_SNIFF_BYTES).arrayBuffer());
		if (head.includes(0)) return "binary";
		return await file.text();
	} catch {
		return "unreadable";
	}
}

/** Sort files into image attachments, path mentions, inline texts and refusals. */
export async function intakeComposerFiles(
	files: readonly File[],
	options: ComposerFileIntakeOptions,
): Promise<ComposerFileIntake> {
	const intake: ComposerFileIntake = { images: [], mentions: [], texts: [], rejected: [], duplicates: 0 };
	const seen: Record<string, true> = {};
	for (const file of files) {
		// A file with no bytes is refused whether it has a path or not (a folder reports zero bytes: it is not a file).
		if (file.size === 0 && !options.directories?.has(file)) {
			intake.rejected.push({ name: file.name, reason: "empty" });
			continue;
		}
		if (attachesAsImage(file, options)) {
			intake.images.push(file);
			continue;
		}
		const mention = (path: string): void => {
			const token = fileMentionFor(path, options.cwd);
			// The same file twice in one drop or pick is one mention.
			if (seen[token]) intake.duplicates++;
			else intake.mentions.push(token);
			seen[token] = true;
		};
		const notSent = (error: unknown): void => {
			intake.rejected.push({
				name: file.name,
				reason: "notSent",
				message: error instanceof Error ? error.message : String(error),
			});
		};
		// A folder on this computer cannot reach a tab running on another one (its path means nothing there).
		if (options.remote && options.directories?.has(file)) {
			intake.rejected.push({ name: file.name, reason: "remoteFolder" });
			continue;
		}
		let path: string;
		try {
			path = options.remote ? "" : await options.pathFor(file);
		} catch (error) {
			notSent(error);
			continue;
		}
		if (path) {
			mention(path);
			continue;
		}
		// No path to name it by: a document, a binary or an oversized file goes to the computer the tab runs on.
		const text = isDocument(file) ? "binary" : await readText(file);
		if (text === "binary" || text === "tooLarge") {
			try {
				mention(await options.sendToHost(file));
			} catch (error) {
				notSent(error);
			}
			continue;
		}
		if (text === "empty" || text === "unreadable") intake.rejected.push({ name: file.name, reason: text });
		else intake.texts.push({ name: file.name, content: text });
	}
	return intake;
}

/** Attachment block for a file's text (the TUI paste wrapper, with the file name). */
export function fileTextAttachment(name: string, content: string): string {
	return `<attachment name="${name.replace(/"/g, "'")}">\n${content}\n</attachment>`;
}
