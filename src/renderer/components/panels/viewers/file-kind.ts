/**
 * Extension → viewer dispatch for the Files drawer. The extension picks the
 * viewer; content can still demote a text kind to the hex view (`fs.read`
 * reports a NUL byte as `binary`). Pure functions so tests and the tree's
 * icons share one table.
 */

export type ViewerKind =
	| "markdown"
	| "code"
	| "image"
	| "pdf"
	| "audio"
	| "video"
	| "csv"
	| "json"
	| "html"
	| "notebook"
	| "mermaid"
	| "docx"
	| "xlsx"
	| "pptx"
	| "office"
	| "binary";

/** Icon family for the file tree (lucide glyph chosen in FileIcon). */
export type FileIconKind =
	| "code"
	| "text"
	| "markdown"
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "archive"
	| "table"
	| "json"
	| "file";

/** Extensions with a dedicated viewer; anything absent is read as text (`code`). */
const KIND_BY_EXT: Readonly<Record<string, ViewerKind>> = {
	md: "markdown",
	mdx: "markdown",
	markdown: "markdown",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	bmp: "image",
	ico: "image",
	svg: "image",
	pdf: "pdf",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	oga: "audio",
	opus: "audio",
	flac: "audio",
	aac: "audio",
	m4a: "audio",
	mp4: "video",
	m4v: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
	ogv: "video",
	csv: "csv",
	tsv: "csv",
	json: "json",
	jsonl: "json",
	ndjson: "json",
	geojson: "json",
	webmanifest: "json",
	html: "html",
	htm: "html",
	xhtml: "html",
	ipynb: "notebook",
	mmd: "mermaid",
	mermaid: "mermaid",
	docx: "docx",
	xlsx: "xlsx",
	pptx: "pptx",
	// Office formats without an in-app reader (binary or OpenDocument/iWork): the fallback card.
	doc: "office",
	xls: "office",
	ppt: "office",
	odt: "office",
	ods: "office",
	odp: "office",
	key: "office",
	pages: "office",
	numbers: "office",
	// Known non-text formats skip the text read and go straight to the hex view.
	zip: "binary",
	gz: "binary",
	tgz: "binary",
	tar: "binary",
	"7z": "binary",
	rar: "binary",
	bz2: "binary",
	xz: "binary",
	zst: "binary",
	jar: "binary",
	war: "binary",
	dmg: "binary",
	iso: "binary",
	bin: "binary",
	dat: "binary",
	exe: "binary",
	dll: "binary",
	so: "binary",
	dylib: "binary",
	o: "binary",
	a: "binary",
	lib: "binary",
	class: "binary",
	pyc: "binary",
	wasm: "binary",
	sqlite: "binary",
	sqlite3: "binary",
	db: "binary",
	woff: "binary",
	woff2: "binary",
	ttf: "binary",
	otf: "binary",
	eot: "binary",
	pkg: "binary",
	msi: "binary",
	deb: "binary",
	rpm: "binary",
	apk: "binary",
	ipa: "binary",
	psd: "binary",
	sketch: "binary",
	fig: "binary",
	heic: "binary",
	tif: "binary",
	tiff: "binary",
};

/** Icon overrides that the viewer kind alone doesn't decide. */
const ICON_BY_EXT: Readonly<Record<string, FileIconKind>> = {
	zip: "archive",
	gz: "archive",
	tgz: "archive",
	tar: "archive",
	"7z": "archive",
	rar: "archive",
	bz2: "archive",
	xz: "archive",
	zst: "archive",
	jar: "archive",
	war: "archive",
	dmg: "archive",
	iso: "archive",
	xlsx: "table",
	xls: "table",
	ods: "table",
	numbers: "table",
	txt: "text",
	log: "text",
	text: "text",
	rst: "text",
	adoc: "text",
	env: "text",
	ini: "text",
	cfg: "text",
	conf: "text",
	lock: "text",
};

const ICON_BY_KIND: Readonly<Record<ViewerKind, FileIconKind>> = {
	markdown: "markdown",
	code: "code",
	image: "image",
	pdf: "pdf",
	audio: "audio",
	video: "video",
	csv: "table",
	json: "json",
	html: "code",
	notebook: "code",
	mermaid: "code",
	docx: "text",
	xlsx: "table",
	pptx: "file",
	office: "file",
	binary: "file",
};

/** Lowercased extension without the dot; "" when the name has none (dotfiles count as none). */
export function fileExtension(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function viewerKind(path: string): ViewerKind {
	return KIND_BY_EXT[fileExtension(path)] ?? "code";
}

export function fileIconKind(path: string): FileIconKind {
	const ext = fileExtension(path);
	if (ext === "") return "text";
	return ICON_BY_EXT[ext] ?? ICON_BY_KIND[viewerKind(path)];
}
