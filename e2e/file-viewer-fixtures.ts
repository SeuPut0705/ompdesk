import * as fs from "node:fs/promises";
import * as path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { tinyPdf } from "./tiny-pdf";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** An OOXML package from its parts; `[Content_Types].xml` lists `overrides` (part → content type). */
async function ooxmlPackage(
	parts: Record<string, string | Buffer>,
	overrides: Record<string, string>,
): Promise<Buffer> {
	const zip = new JSZip();
	const types = Object.entries(overrides)
		.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
		.join("");
	zip.file(
		"[Content_Types].xml",
		`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${types}</Types>`,
	);
	for (const [name, data] of Object.entries(parts)) zip.file(name, data);
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A relationships part: [id, type suffix, target, external?]. */
function rels(entries: [string, string, string, boolean?][]): string {
	const body = entries
		.map(
			([id, type, target, external]) =>
				`<Relationship Id="${id}" Type="${DOC_REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
		)
		.join("");
	return `${XML_HEAD}<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

/** A Word document: a heading, a body paragraph, and a hyperlink to an outside URL (rendered inert). */
export function tinyDocx(): Promise<Buffer> {
	const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
	const R = `xmlns:r="${DOC_REL}"`;
	const document = `${XML_HEAD}<w:document ${W} ${R}><w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue grew 12% this quarter, </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>driven by the new viewer.</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId1"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>Read the full analysis</w:t></w:r></w:hyperlink></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
	return ooxmlPackage(
		{
			"_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
			"word/document.xml": document,
			"word/_rels/document.xml.rels": rels([["rId1", "hyperlink", "https://example.com/full-analysis", true]]),
		},
		{ "word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" },
	);
}

/** An Excel workbook: two sheets, shared and inline strings (one with quotes), a percent, a date and a grouped number. */
export function tinyXlsx(): Promise<Buffer> {
	const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
	const sheet = (rows: string) => `${XML_HEAD}<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`;
	const strings = ["Name", "Quote", "Ada", 'Said "hello", then left', "Region", "Total"];
	return ooxmlPackage(
		{
			"_rels/.rels": rels([["rId1", "officeDocument", "xl/workbook.xml"]]),
			"xl/workbook.xml": `${XML_HEAD}<workbook ${S} xmlns:r="${DOC_REL}"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Regions" sheetId="2" r:id="rId2"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels([
				["rId1", "worksheet", "worksheets/sheet1.xml"],
				["rId2", "worksheet", "worksheets/sheet2.xml"],
				["rId3", "sharedStrings", "sharedStrings.xml"],
				["rId4", "styles", "styles.xml"],
			]),
			"xl/sharedStrings.xml": `${XML_HEAD}<sst ${S} count="${strings.length}" uniqueCount="${strings.length}">${strings
				.map(text => `<si><t>${text.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</t></si>`)
				.join("")}</sst>`,
			"xl/styles.xml": `${XML_HEAD}<styleSheet ${S}><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="14"/><xf numFmtId="4"/></cellXfs></styleSheet>`,
			"xl/worksheets/sheet1.xml": sheet(
				'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
					'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
					'<row r="3"><c r="A3" t="inlineStr"><is><t>Growth</t></is></c><c r="B3" s="1"><v>0.25</v></c></row>' +
					'<row r="4"><c r="A4" t="inlineStr"><is><t>Reported</t></is></c><c r="B4" s="2"><v>45306</v></c></row>',
			),
			"xl/worksheets/sheet2.xml": sheet(
				'<row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1" t="s"><v>5</v></c></row>' +
					'<row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2" s="3"><v>1234.5</v></c></row>',
			),
		},
		{
			"xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
			"xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
			"xl/worksheets/sheet2.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
			"xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
			"xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
		},
	);
}

/** A PowerPoint deck: two slides with titles and bullets, speaker notes on the first, a PNG on the second. */
export async function tinyPptx(): Promise<Buffer> {
	const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${DOC_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
	const shape = (id: number, type: string | null, paragraphs: [string, number][]) =>
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}"/>` : '<p:ph idx="1"/>'}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs
			.map(
				([text, level]) =>
					`<a:p>${level > 0 ? `<a:pPr lvl="${level}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`,
			)
			.join("")}</p:txBody></p:sp>`;
	const slide = (body: string) =>
		`${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
	const picture =
		'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Chart"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>';
	const png = await sharp({
		create: { width: 120, height: 80, channels: 4, background: { r: 40, g: 110, b: 220, alpha: 1 } },
	})
		.png()
		.toBuffer();
	const slideType = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
	return ooxmlPackage(
		{
			"_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
			"ppt/presentation.xml": `${XML_HEAD}<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": rels([
				["rId3", "slide", "slides/slide2.xml"],
				["rId7", "slide", "slides/slide1.xml"],
			]),
			"ppt/slides/slide1.xml": slide(
				shape(2, "title", [["Roadmap 2025", 0]]) +
					shape(3, null, [
						["Ship the Office viewer", 0],
						["Word, Excel and PowerPoint", 1],
					]),
			),
			"ppt/slides/_rels/slide1.xml.rels": rels([["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"]]),
			"ppt/notesSlides/notesSlide1.xml": `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(2, "sldImg", [])}${shape(3, "body", [["Mention remote tabs", 0]])}</p:spTree></p:cSld></p:notes>`,
			"ppt/slides/slide2.xml": slide(
				shape(2, "title", [["Results", 0]]) + shape(3, null, [["Revenue up 12%", 0]]) + picture,
			),
			"ppt/slides/_rels/slide2.xml.rels": rels([["rId2", "image", "../media/image1.png"]]),
			"ppt/media/image1.png": png,
		},
		{
			"ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
			"ppt/slides/slide1.xml": slideType,
			"ppt/slides/slide2.xml": slideType,
			"ppt/notesSlides/notesSlide1.xml":
				"application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
		},
	);
}

/** Two seconds of a 440 Hz tone, 8 kHz mono 16-bit PCM. */
export function tinyWav(): Buffer {
	const rate = 8000;
	const samples = rate * 2;
	const buffer = Buffer.alloc(44 + samples * 2);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + samples * 2, 4);
	buffer.write("WAVEfmt ", 8);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(rate, 24);
	buffer.writeUInt32LE(rate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(samples * 2, 40);
	for (let i = 0; i < samples; i++) {
		buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), 44 + i * 2);
	}
	return buffer;
}

const NOTEBOOK = {
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { language_info: { name: "python" } },
	cells: [
		{ cell_type: "markdown", metadata: {}, source: ["# Notebook title\n", "Some **bold** notes."] },
		{
			cell_type: "code",
			execution_count: 1,
			metadata: {},
			source: ["def greet(name):\n", "    return f'hi {name}'\n", "print(greet('omp'))"],
			outputs: [{ output_type: "stream", name: "stdout", text: ["hi omp\n"] }],
		},
	],
};

/** Write one sample of every viewer kind into `dir`; returns the file names. */
export async function writeViewerSamples(dir: string): Promise<string[]> {
	const png = await sharp({
		create: { width: 96, height: 64, channels: 4, background: { r: 230, g: 90, b: 40, alpha: 1 } },
	})
		.png()
		.toBuffer();
	const files: Record<string, string | Buffer> = {
		"sample.ts": [
			"// Greets a user by name.",
			"export function greet(name: string): string {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source text containing a template literal
			"\tconst message = `Hello, ${name}!`;",
			"\treturn message;",
			"}",
			`export const WIDE = "${"wide ".repeat(30).trim()}";`,
			"",
		].join("\n"),
		"notes.md": "# Release notes\n\n- First item\n- Second item with `code`\n",
		"pixel.png": png,
		"doc.pdf": tinyPdf(),
		"tone.wav": tinyWav(),
		"people.csv": 'name,city,quote\nAda,London,"Said ""hello"", then left"\n"Smith, J",Paris,plain\n',
		"config.json": JSON.stringify({ name: "omp", features: ["viewer", "pdf"], nested: { ok: true } }),
		"page.html": "<!doctype html><html><body><h1>HTML page</h1><p>Rendered in a sandbox.</p></body></html>",
		"analysis.ipynb": JSON.stringify(NOTEBOOK, null, 1),
		"blob.bin": Buffer.from([0x00, 0x01, 0x02, 0xff, 0x4f, 0x4d, 0x50, 0x00, 0x7f, 0x80, 0x41, 0x42, 0x43]),
		"report.docx": await tinyDocx(),
		"budget.xlsx": await tinyXlsx(),
		"deck.pptx": await tinyPptx(),
	};
	await Promise.all(Object.entries(files).map(([name, data]) => fs.writeFile(path.join(dir, name), data)));
	return Object.keys(files);
}
