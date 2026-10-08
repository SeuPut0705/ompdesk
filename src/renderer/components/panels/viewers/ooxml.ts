/**
 * Shared reading for the Office Open XML viewers (xlsx, pptx): the zip
 * package through JSZip, a small XML scanner, and part relationships.
 * Imported only from the lazily loaded office readers, so JSZip stays out of
 * the startup bundle. The scanner is deliberately tiny and DOM-free: OOXML
 * parts are well-formed XML without DTDs, it behaves the same in the
 * renderer and in tests, and a sheet can stop scanning at the row cap.
 */
import JSZip from "jszip";

/** Ceiling for one decompressed XML part, so a zip bomb cannot exhaust memory. */
export const PART_TEXT_CAP = 32 * 1024 * 1024;

export type XmlAttributes = Readonly<Record<string, string>>;

/** Return `false` from a callback to stop the scan. */
export interface XmlHandler {
	open?: (name: string, attrs: XmlAttributes, selfClosing: boolean) => undefined | false;
	close?: (name: string) => undefined | false;
	text?: (text: string) => undefined | false;
}

export interface XmlElement {
	/** Local name, namespace prefix dropped (`a:t` → `t`). */
	name: string;
	/** Attributes as written, prefixes kept (`r:embed`); read them with `attr`. */
	attrs: XmlAttributes;
	children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const TOKEN =
	/<(?:(\/)?([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|!\[CDATA\[([\s\S]*?)\]\]>|!--[\s\S]*?-->|\?[\s\S]*?\?>|![^>]*>)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(ENTITY, (match, body: string) => {
		const named = NAMED_ENTITIES[body];
		if (named !== undefined) return named;
		const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
		return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

function parseAttributes(source: string): XmlAttributes {
	const attrs: Record<string, string> = {};
	if (source === "") return attrs;
	for (const match of source.matchAll(ATTRIBUTE)) {
		attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
	}
	return attrs;
}

/** Streams start tags, end tags and text (entities decoded, CDATA as text) in document order. */
export function scanXml(xml: string, handler: XmlHandler): void {
	// A fresh lastIndex per scan: callbacks may start another scan.
	const token = new RegExp(TOKEN);
	let cursor = 0;
	for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
		if (match.index > cursor && handler.text) {
			if (handler.text(decodeEntities(xml.slice(cursor, match.index))) === false) return;
		}
		cursor = token.lastIndex;
		const [, closing, name, attributes, selfClosing, cdata] = match;
		if (name !== undefined) {
			const local = name.slice(name.indexOf(":") + 1);
			if (closing) {
				if (handler.close?.(local) === false) return;
			} else {
				if (handler.open?.(local, parseAttributes(attributes ?? ""), selfClosing !== undefined) === false) return;
				if (selfClosing !== undefined && handler.close?.(local) === false) return;
			}
		} else if (cdata !== undefined && handler.text) {
			if (handler.text(cdata) === false) return;
		}
	}
}

/** The whole part as a tree; for the small parts (workbook, rels, slides). */
export function parseXml(xml: string): XmlElement {
	const root: XmlElement = { name: "#document", attrs: {}, children: [] };
	const stack: XmlElement[] = [root];
	scanXml(xml, {
		open: (name, attrs) => {
			const element: XmlElement = { name, attrs, children: [] };
			stack[stack.length - 1].children.push(element);
			stack.push(element);
			return undefined;
		},
		close: () => {
			if (stack.length > 1) stack.pop();
			return undefined;
		},
		text: text => {
			stack[stack.length - 1].children.push(text);
			return undefined;
		},
	});
	return root;
}

export function childElements(element: XmlElement, name?: string): XmlElement[] {
	const out: XmlElement[] = [];
	for (const child of element.children) {
		if (typeof child !== "string" && (name === undefined || child.name === name)) out.push(child);
	}
	return out;
}

/** Descendants named `name`, in document order. */
export function findAll(element: XmlElement, name: string): XmlElement[] {
	const out: XmlElement[] = [];
	const visit = (node: XmlElement) => {
		for (const child of node.children) {
			if (typeof child === "string") continue;
			if (child.name === name) out.push(child);
			visit(child);
		}
	};
	visit(element);
	return out;
}

export function findFirst(element: XmlElement, name: string): XmlElement | undefined {
	for (const child of element.children) {
		if (typeof child === "string") continue;
		if (child.name === name) return child;
		const nested = findFirst(child, name);
		if (nested) return nested;
	}
	return undefined;
}

/** Attribute by local name: `attr(el, "embed")` reads `r:embed`. */
export function attr(element: XmlElement | undefined, name: string): string | undefined {
	if (!element) return undefined;
	const direct = element.attrs[name];
	if (direct !== undefined) return direct;
	const suffix = `:${name}`;
	for (const key of Object.keys(element.attrs)) {
		if (key.endsWith(suffix)) return element.attrs[key];
	}
	return undefined;
}

/** A part path resolved against the part that references it (`ppt/slides/slide1.xml` + `../media/a.png`). */
export function resolvePartPath(sourcePart: string, target: string): string {
	let decoded = target;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		// A stray `%` in a hand-made package: use the target as written.
	}
	const joined = decoded.startsWith("/")
		? decoded.slice(1)
		: sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1) + decoded;
	const segments: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
}

export interface Relationship {
	type: string;
	/** Resolved part path, or the raw URL when `external`. */
	target: string;
	external: boolean;
}

export interface OfficePackage {
	/** Every file path in the package. */
	paths(): string[];
	/**
	 * UTF-8 text of a part, at most `maxBytes` decompressed; `complete` is
	 * false when the part was longer. `null` when the part is missing.
	 */
	text(path: string, maxBytes?: number): Promise<{ text: string; complete: boolean } | null>;
	bytes(path: string): Promise<Uint8Array | null>;
	/** The part's relationships by id (`word/_rels/document.xml.rels` for `word/document.xml`). */
	rels(part: string): Promise<Map<string, Relationship>>;
}

/** JSZip's per-entry stream; present on every entry, missing from its typings. */
interface ZipStream {
	on(event: "data", callback: (chunk: Uint8Array) => void): ZipStream;
	on(event: "end", callback: () => void): ZipStream;
	on(event: "error", callback: (error: Error) => void): ZipStream;
	resume(): ZipStream;
	pause(): ZipStream;
}

type StreamableEntry = JSZip.JSZipObject & { internalStream(type: "uint8array"): ZipStream };

function readPrefix(entry: JSZip.JSZipObject, maxBytes: number): Promise<{ text: string; complete: boolean }> {
	const stream = (entry as StreamableEntry).internalStream("uint8array");
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let settled = false;
	const { promise, resolve, reject } = Promise.withResolvers<{ text: string; complete: boolean }>();
	stream
		.on("data", chunk => {
			if (settled) return;
			bytes += chunk.length;
			text += decoder.decode(chunk, { stream: true });
			if (bytes >= maxBytes) {
				settled = true;
				stream.pause();
				resolve({ text, complete: false });
			}
		})
		.on("error", error => {
			if (settled) return;
			settled = true;
			reject(error);
		})
		.on("end", () => {
			if (settled) return;
			settled = true;
			resolve({ text: text + decoder.decode(), complete: true });
		})
		.resume();
	return promise;
}

/** Package part names are case-insensitive; zips store whatever case the writer used. */
export async function openPackage(data: Uint8Array): Promise<OfficePackage> {
	const zip = await JSZip.loadAsync(data);
	const entries = new Map<string, JSZip.JSZipObject>();
	zip.forEach((_, entry) => {
		if (!entry.dir) entries.set(entry.name.toLowerCase(), entry);
	});
	const entry = (path: string) => entries.get(path.replace(/^\//, "").toLowerCase());
	const relsCache = new Map<string, Promise<Map<string, Relationship>>>();

	const text = async (path: string, maxBytes = PART_TEXT_CAP) => {
		const found = entry(path);
		return found ? readPrefix(found, maxBytes) : null;
	};

	const loadRels = async (part: string): Promise<Map<string, Relationship>> => {
		const slash = part.lastIndexOf("/");
		const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
		const rels = new Map<string, Relationship>();
		const source = await text(relsPath);
		if (!source) return rels;
		for (const rel of findAll(parseXml(source.text), "Relationship")) {
			const id = attr(rel, "Id");
			const target = attr(rel, "Target");
			if (!id || target === undefined) continue;
			const external = attr(rel, "TargetMode") === "External";
			rels.set(id, {
				type: attr(rel, "Type") ?? "",
				target: external ? target : resolvePartPath(part, target),
				external,
			});
		}
		return rels;
	};

	return {
		paths: () => [...entries.values()].map(found => found.name),
		text,
		bytes: async path => {
			const found = entry(path);
			return found ? found.async("uint8array") : null;
		},
		rels: part => {
			let cached = relsCache.get(part);
			if (!cached) {
				cached = loadRels(part);
				relsCache.set(part, cached);
			}
			return cached;
		},
	};
}

/** The main part a package's root relationships point at (`xl/workbook.xml`, `ppt/presentation.xml`). */
export async function mainPart(pkg: OfficePackage, fallback: string): Promise<string> {
	for (const rel of (await pkg.rels("")).values()) {
		if (!rel.external && rel.type.endsWith("/officeDocument")) return rel.target;
	}
	return fallback;
}

/** Relationship type ends with `/<kind>` (`…/relationships/worksheet`). */
export function relIs(rel: Relationship, kind: string): boolean {
	return rel.type.endsWith(`/${kind}`);
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
};

/** MIME an <img> can show for this part, or null (EMF, WMF, TIFF…). */
export function imageMime(path: string): string | null {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return path.includes(".") && Object.hasOwn(IMAGE_MIME, ext) ? IMAGE_MIME[ext] : null;
}
