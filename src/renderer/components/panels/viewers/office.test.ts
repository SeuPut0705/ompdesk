/**
 * The Office readers' pure parts: the OOXML scanner and part paths, xlsx
 * sheet-to-rows with number formats and caps, pptx slide extraction (text,
 * images, notes, order), and the docx containment pass. The packages come
 * from the same builders the e2e fixtures use.
 */
import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { tinyPptx, tinyXlsx } from "../../../../../e2e/file-viewer-fixtures";
import { stripExternalResources } from "./docx-runtime";
import { decodeEntities, parseXml, resolvePartPath, scanXml } from "./ooxml";
import { extractSlideText, readPresentation } from "./pptx";
import { formatNumber, openWorkbook, type SheetContext, sheetToRows } from "./xlsx";

const NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

describe("ooxml", () => {
	it("scans tags, attributes, entities and CDATA in order", () => {
		const events: string[] = [];
		scanXml(
			'<?xml version="1.0"?><a:p x="1 &amp; 2"><a:t>A &lt;b&gt; &#x41;&#66;</a:t><br/><![CDATA[<raw>]]></a:p>',
			{
				open: (name, attrs, selfClosing) => {
					events.push(`open ${name} ${JSON.stringify(attrs)} ${selfClosing}`);
					return undefined;
				},
				close: name => {
					events.push(`close ${name}`);
					return undefined;
				},
				text: text => {
					events.push(`text ${text}`);
					return undefined;
				},
			},
		);
		expect(events).toEqual([
			'open p {"x":"1 & 2"} false',
			"open t {} false",
			"text A <b> AB",
			"close t",
			"open br {} true",
			"close br",
			"text <raw>",
			"close p",
		]);
		expect(decodeEntities("&#xFFFFFFF; &bogus;")).toBe("&#xFFFFFFF; &bogus;");
	});

	it("stops scanning when a callback returns false", () => {
		const names: string[] = [];
		scanXml("<r><c/><c/><c/></r>", {
			open: name => {
				names.push(name);
				return names.length === 2 ? false : undefined;
			},
		});
		expect(names).toEqual(["r", "c"]);
	});

	it("resolves relationship targets against the source part", () => {
		expect(resolvePartPath("ppt/slides/slide1.xml", "../media/image%201.png")).toBe("ppt/media/image 1.png");
		expect(resolvePartPath("xl/workbook.xml", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
		expect(resolvePartPath("xl/workbook.xml", "/xl/styles.xml")).toBe("xl/styles.xml");
		expect(resolvePartPath("", "word/document.xml")).toBe("word/document.xml");
	});

	it("builds a tree with local names and prefixed attributes", () => {
		const root = parseXml(`<p:sld ${NS}><a:blip r:embed="rId2"/></p:sld>`);
		const sld = root.children[0];
		expect(typeof sld !== "string" && sld.name).toBe("sld");
		const blip = typeof sld !== "string" ? sld.children[0] : null;
		expect(blip && typeof blip !== "string" ? blip.attrs["r:embed"] : null).toBe("rId2");
	});
});

describe("xlsx", () => {
	const context: SheetContext = {
		sharedStrings: ["Name", 'Said "hello"'],
		formats: ["General", "0%", "yyyy-mm-dd", "#,##0.00"],
		date1904: false,
	};
	const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
	const texts = (rows: { text: string }[][]) => rows.map(row => row.map(cell => cell.text));

	it("turns a sheet into a dense grid of display strings", () => {
		const grid = sheetToRows(
			sheet(
				'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
					'<row r="3"><c r="A3" t="inlineStr"><is><r><t>rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></is></c>' +
					'<c r="B3" s="1"><v>0.25</v></c><c r="C3" s="2"><v>45306</v></c></row>' +
					'<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="e"><v>#DIV/0!</v></c><c r="C4" s="3"><f>SUM(A1:A2)</f><v>1234.5</v></c></row>' +
					'<row r="5"><c r="A5" t="str"><v>formula text</v></c><c r="B5" t="inlineStr"><is><t>Line_x000D_ break</t></is></c><c r="C5"><v>0.30000000000000004</v></c></row>',
			),
			context,
		);
		expect(grid.columns).toBe(3);
		expect(texts(grid.rows)).toEqual([
			["Name", "", 'Said "hello"'],
			["", "", ""],
			["rich text", "25%", "2024-01-15"],
			["TRUE", "#DIV/0!", "1,234.50"],
			["formula text", "Line\r break", "0.3"],
		]);
		expect(grid.rows[2].map(cell => cell.numeric)).toEqual([false, true, true]);
		expect(grid.clippedRows || grid.clippedColumns).toBe(false);
	});

	it("caps rows and columns and marks the clipping", () => {
		const rows = Array.from(
			{ length: 6 },
			(_, r) =>
				`<row r="${r + 1}">${["A", "B", "C", "D"].map(c => `<c r="${c}${r + 1}"><v>${r}</v></c>`).join("")}</row>`,
		).join("");
		const grid = sheetToRows(sheet(rows), context, true, { rows: 4, columns: 2 });
		expect(texts(grid.rows)).toEqual([
			["0", "0"],
			["1", "1"],
			["2", "2"],
			["3", "3"],
		]);
		expect(grid).toMatchObject({ columns: 2, clippedRows: true, clippedColumns: true });
		// Formatting-only rows past the cap are not clipping.
		expect(
			sheetToRows(sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="9"/>'), context, true, {
				rows: 4,
				columns: 2,
			}).clippedRows,
		).toBe(false);
	});

	it("keeps the rows of a part cut at the size cap", () => {
		const grid = sheetToRows(
			sheet('<row r="1"><c r="A1"><v>7</v></c></row><row r="2"><c r="A2"><v>12'),
			context,
			false,
		);
		expect(texts(grid.rows)).toEqual([["7"]]);
		expect(grid.clippedRows).toBe(true);
	});

	it("formats numbers like the spreadsheet", () => {
		expect(formatNumber(1234.5, "#,##0.00")).toBe("1,234.50");
		expect(formatNumber(0.125, "0.0%")).toBe("12.5%");
		expect(formatNumber(-5, "#,##0;(#,##0)")).toBe("(5)");
		expect(formatNumber(-5, "0.0")).toBe("-5.0");
		expect(formatNumber(1234, '"$"#,##0')).toBe("$1,234");
		expect(formatNumber(1234, "[$€-407]#,##0.00")).toBe("€1,234.00");
		expect(formatNumber(1234, "[Red]#,##0")).toBe("1,234");
		expect(formatNumber(12_345_678, "0.00E+00")).toBe("1.23E+07");
		expect(formatNumber(1_500_000, '#,##0.0,,"M"')).toBe("1.5M");
		expect(formatNumber(0.5, "#.##")).toBe(".5");
		expect(formatNumber(0, '0;-0;"zero"')).toBe("zero");
		expect(formatNumber(123_456_789_012, "General")).toBe("1.23457E+11");
		expect(formatNumber(45306, "mmm d, yyyy")).toBe("Jan 15, 2024");
		expect(formatNumber(45306, "dddd")).toBe("Monday");
		expect(formatNumber(45306.75, "yyyy-mm-dd h:mm")).toBe("2024-01-15 18:00");
		expect(formatNumber(0.5625, "h:mm AM/PM")).toBe("1:30 PM");
		expect(formatNumber(1.5, "[h]:mm")).toBe("36:00");
		expect(formatNumber(61, "yyyy-mm-dd")).toBe("1900-03-01");
		expect(formatNumber(0, "yyyy-mm-dd", true)).toBe("1904-01-01");
	});

	it("reads a workbook's sheets and switches between them", async () => {
		const workbook = await openWorkbook(new Uint8Array(await tinyXlsx()));
		expect(workbook.sheets.map(sheetRef => sheetRef.name)).toEqual(["Summary", "Regions"]);
		expect(texts((await workbook.readSheet(0)).rows)).toEqual([
			["Name", "Quote"],
			["Ada", 'Said "hello", then left'],
			["Growth", "25%"],
			["Reported", "2024-01-15"],
		]);
		expect(texts((await workbook.readSheet(1)).rows)).toEqual([
			["Region", "Total"],
			["North", "1,234.50"],
		]);
	});

	it("hides hidden sheets and gives chart sheets no cells", async () => {
		const zip = await JSZip.loadAsync(await tinyXlsx());
		zip.file(
			"xl/workbook.xml",
			'<workbook xmlns:r="r"><sheets><sheet name="Summary" r:id="rId1"/><sheet name="Secret" state="hidden" r:id="rId2"/><sheet name="Chart" r:id="rId9"/></sheets></workbook>',
		);
		const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
		zip.file(
			"xl/_rels/workbook.xml.rels",
			(rels ?? "").replace(
				"</Relationships>",
				'<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>',
			),
		);
		const workbook = await openWorkbook(await zip.generateAsync({ type: "uint8array" }));
		expect(workbook.sheets).toEqual([
			{ name: "Summary", path: "xl/worksheets/sheet1.xml" },
			{ name: "Chart", path: null },
		]);
		expect((await workbook.readSheet(1)).rows).toEqual([]);
	});
});

describe("pptx", () => {
	const shape = (type: string | null, body: string) =>
		`<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;

	it("extracts the title, paragraphs with levels, tables and picture ids in reading order", () => {
		const xml = `<p:sld ${NS} show="0"><p:cSld><p:spTree>
			${shape("title", "<a:p><a:r><a:t>Plan</a:t></a:r></a:p>")}
			${shape(null, '<a:p><a:r><a:t>First</a:t></a:r><a:br/><a:r><a:t>line two</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:fld type="slidenum"><a:t>deep</a:t></a:fld></a:p><a:p><a:r><a:t> </a:t></a:r></a:p>')}
			${shape("sldNum", "<a:p><a:r><a:t>7</a:t></a:r></a:p>")}
			<p:grpSp>${shape(null, "<a:p><a:r><a:t>Grouped</a:t></a:r></a:p>")}</p:grpSp>
			<p:graphicFrame><a:graphic><a:graphicData><a:tbl>
				<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>10</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
			</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
			<p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic>
			<p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic>
			<p:pic><p:blipFill><a:blip r:link="rId6"/></p:blipFill></p:pic>
		</p:spTree></p:cSld></p:sld>`;
		expect(extractSlideText(xml)).toEqual({
			title: "Plan",
			paragraphs: [
				{ text: "First\nline two", level: 0 },
				{ text: "deep", level: 2 },
				{ text: "Grouped", level: 0 },
				{ text: "Q1 | 10", level: 0 },
			],
			imageIds: ["rId5"],
			linkedImages: 1,
			hidden: true,
		});
	});

	it("reads the notes body placeholder only", () => {
		const xml = `<p:notes ${NS}><p:cSld><p:spTree>${shape("sldImg", "")}${shape("body", "<a:p><a:r><a:t>Say hi</a:t></a:r></a:p>")}${shape("sldNum", "<a:p><a:r><a:t>1</a:t></a:r></a:p>")}</p:spTree></p:cSld></p:notes>`;
		expect(extractSlideText(xml, "body").paragraphs).toEqual([{ text: "Say hi", level: 0 }]);
	});

	it("reads slides in presentation order with their images and notes", async () => {
		const slides = await readPresentation(new Uint8Array(await tinyPptx()));
		expect(slides.map(slide => [slide.number, slide.title, slide.paragraphs, slide.notes])).toEqual([
			[
				1,
				"Roadmap 2025",
				[
					{ text: "Ship the Office viewer", level: 0 },
					{ text: "Word, Excel and PowerPoint", level: 1 },
				],
				["Mention remote tabs"],
			],
			[2, "Results", [{ text: "Revenue up 12%", level: 0 }], []],
		]);
		expect(slides[0].images).toEqual([]);
		expect(slides[1].images).toHaveLength(1);
		expect(slides[1].images[0]).toMatchObject({ name: "image1.png", mime: "image/png" });
		// The PNG signature: real bytes from the package.
		expect([...slides[1].images[0].data.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
	});

	it("counts images it cannot show", async () => {
		const zip = await JSZip.loadAsync(await tinyPptx());
		zip.file("ppt/media/image1.emf", new Uint8Array([1, 2, 3]));
		const rels = (await zip.file("ppt/slides/_rels/slide2.xml.rels")?.async("string")) ?? "";
		zip.file("ppt/slides/_rels/slide2.xml.rels", rels.replace("image1.png", "image1.emf"));
		const slides = await readPresentation(await zip.generateAsync({ type: "uint8array" }));
		expect(slides[1]).toMatchObject({ images: [], skippedImages: 1 });
	});
});

describe("docx containment", () => {
	it("drops outside URLs, link targets, handlers and embedding elements", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const root = document.createElement("div");
		root.innerHTML = `
			<style>@import url(https://evil.example/a.css); p { background: url("https://evil.example/b.png"); } i { background: url(data:image/png;base64,AA==) }</style>
			<p style="background-image: url(http://evil.example/c.png)" onclick="steal()">text</p>
			<a href="https://example.com/doc">link</a>
			<img src="https://evil.example/d.png"><img src="data:image/png;base64,AA==">
			<iframe srcdoc="<p>x</p>"></iframe><object data="x.swf"></object>
			<svg><image href="http://evil.example/e.png"></image></svg>`;
		stripExternalResources(root as unknown as Element);
		const html = root.innerHTML;
		expect(html).not.toContain("evil.example");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<object");
		expect(html).toContain("url(data:image/png;base64,AA==)");
		const link = root.querySelector("a");
		expect(link?.hasAttribute("href")).toBe(false);
		expect(link?.getAttribute("title")).toBe("https://example.com/doc");
		expect([...root.querySelectorAll("img")].map(img => img.getAttribute("src"))).toEqual([
			null,
			"data:image/png;base64,AA==",
		]);
	});
});
