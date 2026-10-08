/**
 * PowerPoint (.pptx) reading for the Files drawer's simplified preview: the
 * slides in presentation order, each with its title, its text paragraphs
 * (`a:t` runs grouped by `a:p`, with the bullet level), table cells, the
 * images it embeds (bytes from the package, never a linked URL) and its
 * speaker notes. Layout, theme and animation are not reproduced. Loaded
 * lazily with JSZip.
 */
import {
	attr,
	childElements,
	findAll,
	findFirst,
	imageMime,
	mainPart,
	type OfficePackage,
	openPackage,
	parseXml,
	relIs,
	type XmlElement,
} from "./ooxml";

export interface SlideParagraph {
	text: string;
	/** Outline level from `a:pPr@lvl`; 0 for top-level text. */
	level: number;
}

export interface SlideImage {
	name: string;
	mime: string;
	data: Uint8Array;
}

export interface Slide {
	/** 1-based position in the presentation. */
	number: number;
	title: string | null;
	paragraphs: SlideParagraph[];
	images: SlideImage[];
	/** Embedded images in a format an <img> can't show (EMF, WMF, TIFF) or linked from outside. */
	skippedImages: number;
	notes: string[];
	hidden: boolean;
}

/** Text of a shape or notes placeholder, as in the slide XML; exported for tests. */
export interface SlideText {
	title: string | null;
	paragraphs: SlideParagraph[];
	/** `r:embed` ids of pictures, in order, deduplicated. */
	imageIds: string[];
	/** Pictures that reference an outside file (`r:link`) instead of embedding it. */
	linkedImages: number;
	hidden: boolean;
}

const TITLE_TYPES: Readonly<Record<string, true>> = { title: true, ctrTitle: true };
/** Placeholders that only echo slide chrome (number, date, footer, the slide thumbnail on a notes page). */
const CHROME_TYPES: Readonly<Record<string, true>> = { sldNum: true, dt: true, ftr: true, hdr: true, sldImg: true };

/** One `a:p`: runs and fields joined, `a:br` as a line break. */
function paragraphText(paragraph: XmlElement): string {
	let out = "";
	const visit = (element: XmlElement) => {
		for (const child of element.children) {
			if (typeof child === "string") continue;
			if (child.name === "t") out += child.children.filter(node => typeof node === "string").join("");
			else if (child.name === "br") out += "\n";
			else if (child.name !== "pPr" && child.name !== "rPr") visit(child);
		}
	};
	visit(paragraph);
	return out;
}

function bodyParagraphs(txBody: XmlElement | undefined): SlideParagraph[] {
	if (!txBody) return [];
	const paragraphs: SlideParagraph[] = [];
	for (const p of childElements(txBody, "p")) {
		const text = paragraphText(p);
		if (text.trim() === "") continue;
		const level = Number(attr(childElements(p, "pPr")[0], "lvl") ?? 0);
		paragraphs.push({ text, level: Number.isInteger(level) && level > 0 ? level : 0 });
	}
	return paragraphs;
}

/**
 * The slide (or notes page) XML to its text in reading order: shapes and
 * groups as they sit in the shape tree, table rows as `cell | cell` lines.
 * With `placeholder`, only placeholders of that type count (notes body).
 */
export function extractSlideText(xml: string, placeholder?: string): SlideText {
	const root = parseXml(xml);
	const slide = findFirst(root, "sld") ?? findFirst(root, "notes") ?? root;
	const titles: string[] = [];
	const paragraphs: SlideParagraph[] = [];

	const visit = (container: XmlElement) => {
		for (const shape of childElements(container)) {
			if (shape.name === "grpSp") {
				visit(shape);
			} else if (shape.name === "sp") {
				const ph = findFirst(childElements(shape, "nvSpPr")[0] ?? shape, "ph");
				const type = attr(ph, "type");
				if (placeholder !== undefined) {
					// Notes: the body placeholder (type "body") holds what the presenter wrote.
					if (ph && (type ?? "body") === placeholder) {
						paragraphs.push(...bodyParagraphs(childElements(shape, "txBody")[0]));
					}
					continue;
				}
				if (type && Object.hasOwn(CHROME_TYPES, type)) continue;
				const text = bodyParagraphs(childElements(shape, "txBody")[0]);
				if (type && Object.hasOwn(TITLE_TYPES, type)) titles.push(text.map(p => p.text).join(" "));
				else paragraphs.push(...text);
			} else if (shape.name === "graphicFrame" && placeholder === undefined) {
				for (const row of findAll(shape, "tr")) {
					const cells = childElements(row, "tc").map(cell =>
						findAll(cell, "p")
							.map(paragraphText)
							.filter(text => text.trim() !== "")
							.join(" "),
					);
					if (cells.some(text => text !== "")) paragraphs.push({ text: cells.join(" | "), level: 0 });
				}
			}
		}
	};
	const tree = findFirst(slide, "spTree");
	if (tree) visit(tree);

	const imageIds: string[] = [];
	let linkedImages = 0;
	if (placeholder === undefined) {
		for (const blip of findAll(slide, "blip")) {
			const embed = attr(blip, "embed");
			if (embed) {
				if (!imageIds.includes(embed)) imageIds.push(embed);
			} else if (attr(blip, "link")) {
				linkedImages++;
			}
		}
	}
	const title = titles.filter(text => text.trim() !== "").join(" ") || null;
	return { title, paragraphs, imageIds, linkedImages, hidden: attr(slide, "show") === "0" };
}

/** Slide part paths in presentation order; numbered slide files when the list is missing. */
async function slidePaths(pkg: OfficePackage): Promise<string[]> {
	const presentationPath = await mainPart(pkg, "ppt/presentation.xml");
	const presentation = await pkg.text(presentationPath);
	if (presentation) {
		const rels = await pkg.rels(presentationPath);
		const ordered = findAll(parseXml(presentation.text), "sldId")
			.map(id => rels.get(attr(id, "id") ?? ""))
			.flatMap(rel => (rel && !rel.external && relIs(rel, "slide") ? [rel.target] : []));
		if (ordered.length > 0) return ordered;
	}
	return pkg
		.paths()
		.flatMap(path => {
			const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(path);
			return match ? [{ path, index: Number(match[1]) }] : [];
		})
		.sort((a, b) => a.index - b.index)
		.map(slide => slide.path);
}

async function readSlide(pkg: OfficePackage, path: string, number: number): Promise<Slide> {
	const xml = await pkg.text(path);
	const text = xml ? extractSlideText(xml.text) : null;
	const rels = await pkg.rels(path);
	const images: SlideImage[] = [];
	let skippedImages = text?.linkedImages ?? 0;
	for (const id of text?.imageIds ?? []) {
		const rel = rels.get(id);
		const mime = rel && !rel.external ? imageMime(rel.target) : null;
		const data = rel && mime ? await pkg.bytes(rel.target) : null;
		if (rel && mime && data) images.push({ name: rel.target.slice(rel.target.lastIndexOf("/") + 1), mime, data });
		else skippedImages++;
	}
	let notes: string[] = [];
	const notesRel = [...rels.values()].find(rel => !rel.external && relIs(rel, "notesSlide"));
	const notesXml = notesRel ? await pkg.text(notesRel.target) : null;
	if (notesXml) notes = extractSlideText(notesXml.text, "body").paragraphs.map(p => p.text);
	return {
		number,
		title: text?.title ?? null,
		paragraphs: text?.paragraphs ?? [],
		images,
		skippedImages,
		notes,
		hidden: text?.hidden ?? false,
	};
}

export async function readPresentation(data: Uint8Array): Promise<Slide[]> {
	const pkg = await openPackage(data);
	const paths = await slidePaths(pkg);
	const slides: Slide[] = [];
	for (const [index, path] of paths.entries()) slides.push(await readSlide(pkg, path, index + 1));
	return slides;
}
