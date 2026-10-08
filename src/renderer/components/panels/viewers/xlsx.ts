/**
 * Excel workbook (.xlsx) reading for the Files drawer: the sheet list,
 * shared strings and number formats, and one sheet at a time as a grid of
 * display strings capped at XLSX_ROW_CAP × XLSX_COLUMN_CAP. Cells show their
 * cached values (formulas are not evaluated) formatted with the cell's number
 * format: General, fixed decimals, grouping, percent, scientific, currency
 * literals and date/time codes. Loaded lazily with JSZip.
 */
import {
	attr,
	childElements,
	findAll,
	findFirst,
	mainPart,
	type OfficePackage,
	openPackage,
	parseXml,
	relIs,
	scanXml,
	type XmlElement,
} from "./ooxml";

export const XLSX_ROW_CAP = 1000;
export const XLSX_COLUMN_CAP = 50;

export interface SheetRef {
	name: string;
	/** Worksheet part; null for a chart or dialog sheet, which has no cells. */
	path: string | null;
}

export interface SheetCell {
	text: string;
	/** Numbers and dates align right, like the spreadsheet does. */
	numeric: boolean;
}

export interface SheetGrid {
	/** Row 1 first, down to the last row with a value (or the cap). */
	rows: SheetCell[][];
	/** Column A through the last column with a value (or the cap). */
	columns: number;
	clippedRows: boolean;
	clippedColumns: boolean;
}

/** What formatting a cell needs from the rest of the workbook. */
export interface SheetContext {
	sharedStrings: readonly string[];
	/** Number format code per cell style (`s` attribute) index. */
	formats: readonly string[];
	date1904: boolean;
}

export interface WorkbookFile {
	sheets: SheetRef[];
	readSheet(index: number): Promise<SheetGrid>;
}

/** Built-in number formats (ECMA-376 §18.8.30); 14 and 22 use an unambiguous ISO order. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
	0: "General",
	1: "0",
	2: "0.00",
	3: "#,##0",
	4: "#,##0.00",
	9: "0%",
	10: "0.00%",
	11: "0.00E+00",
	12: "# ?/?",
	13: "# ??/??",
	14: "yyyy-mm-dd",
	15: "d-mmm-yy",
	16: "d-mmm",
	17: "mmm-yy",
	18: "h:mm AM/PM",
	19: "h:mm:ss AM/PM",
	20: "h:mm",
	21: "h:mm:ss",
	22: "yyyy-mm-dd h:mm",
	37: "#,##0 ;(#,##0)",
	38: "#,##0 ;[Red](#,##0)",
	39: "#,##0.00;(#,##0.00)",
	40: "#,##0.00;[Red](#,##0.00)",
	45: "mm:ss",
	46: "[h]:mm:ss",
	47: "mm:ss.0",
	48: "##0.0E+0",
	49: "@",
};

export async function openWorkbook(data: Uint8Array): Promise<WorkbookFile> {
	const pkg = await openPackage(data);
	const workbookPath = await mainPart(pkg, "xl/workbook.xml");
	const workbookXml = await pkg.text(workbookPath);
	if (!workbookXml) throw new Error("No workbook part in this file");
	const workbook = parseXml(workbookXml.text);
	const rels = await pkg.rels(workbookPath);
	const relsOfType = (kind: string) => [...rels.values()].filter(rel => !rel.external && relIs(rel, kind));

	const declared = findAll(workbook, "sheet");
	const visible = declared.filter(sheet => {
		const state = attr(sheet, "state");
		return state !== "hidden" && state !== "veryHidden";
	});
	const sheets: SheetRef[] = (visible.length > 0 ? visible : declared).map(sheet => {
		const rel = rels.get(attr(sheet, "id") ?? "");
		return {
			name: attr(sheet, "name") ?? "",
			path: rel && !rel.external && relIs(rel, "worksheet") ? rel.target : null,
		};
	});

	const pr = attr(findFirst(workbook, "workbookPr"), "date1904");
	const context: SheetContext = {
		sharedStrings: await readSharedStrings(pkg, relsOfType("sharedStrings")[0]?.target),
		formats: await readCellFormats(pkg, relsOfType("styles")[0]?.target),
		date1904: pr === "1" || pr === "true",
	};

	return {
		sheets,
		readSheet: async index => {
			const path = sheets[index]?.path;
			const xml = path ? await pkg.text(path) : null;
			if (!xml) return { rows: [], columns: 0, clippedRows: false, clippedColumns: false };
			return sheetToRows(xml.text, context, xml.complete);
		},
	};
}

/** Excel escapes control characters in strings as `_xHHHH_`. */
function unescapeExcel(text: string): string {
	return text.includes("_x")
		? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		: text;
}

/** Raw `<t>` runs of a rich string (`<si>`, `<is>`), phonetic guides (`<rPh>`) left out. */
function richRuns(element: XmlElement): string {
	let out = "";
	for (const child of element.children) {
		if (typeof child === "string") continue;
		if (child.name === "t") out += child.children.filter(node => typeof node === "string").join("");
		else if (child.name !== "rPh") out += richRuns(child);
	}
	return out;
}

async function readSharedStrings(pkg: OfficePackage, path: string | undefined): Promise<string[]> {
	const xml = path ? await pkg.text(path) : null;
	if (!xml) return [];
	return findAll(parseXml(xml.text), "si").map(si => unescapeExcel(richRuns(si)));
}

async function readCellFormats(pkg: OfficePackage, path: string | undefined): Promise<string[]> {
	const xml = path ? await pkg.text(path) : null;
	if (!xml) return [];
	const styles = parseXml(xml.text);
	const custom: Record<number, string> = {};
	for (const format of findAll(styles, "numFmt")) {
		custom[Number(attr(format, "numFmtId"))] = attr(format, "formatCode") ?? "General";
	}
	const cellXfs = findFirst(styles, "cellXfs");
	if (!cellXfs) return [];
	return childElements(cellXfs, "xf").map(xf => {
		const id = Number(attr(xf, "numFmtId") ?? 0);
		return custom[id] ?? BUILTIN_FORMATS[id] ?? "General";
	});
}

/** `AB12` → { column: 28, row: 12 }; either part may be absent. */
function parseCellRef(ref: string): { column: number | null; row: number | null } {
	const match = /^\$?([A-Za-z]*)\$?(\d*)$/.exec(ref);
	if (!match) return { column: null, row: null };
	let column = 0;
	for (const letter of match[1].toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
	return { column: column || null, row: match[2] ? Number(match[2]) : null };
}

/**
 * One worksheet part to a dense grid of display strings. `complete` false
 * means the part was cut at the size cap: the rows read so far show, marked
 * clipped.
 */
export function sheetToRows(
	xml: string,
	context: SheetContext,
	complete = true,
	caps: { rows: number; columns: number } = { rows: XLSX_ROW_CAP, columns: XLSX_COLUMN_CAP },
): SheetGrid {
	// A cut part ends mid-tag or mid-value; drop the unfinished tail.
	const source = complete ? xml : xml.slice(0, xml.lastIndexOf("<"));
	const cells = new Map<number, Map<number, SheetCell>>();
	let lastRow = 0;
	let lastColumn = 0;
	let clippedRows = !complete;
	let clippedColumns = false;

	let row = 0;
	let column = 0;
	let cell: { column: number; type: string; style: number } | null = null;
	let value = "";
	let inline = "";
	/** Which text the scanner is inside: the cached `<v>`, an inline `<is><t>`, or neither. */
	let capture: "v" | "t" | null = null;
	let inInline = false;
	let phonetic = 0;

	scanXml(source, {
		open: (name, attrs) => {
			if (name === "row") {
				const r = Number(attrs.r);
				row = Number.isInteger(r) && r > 0 ? r : row + 1;
				column = 0;
			} else if (name === "c") {
				const ref = parseCellRef(attrs.r ?? "");
				column = ref.column ?? column + 1;
				if (ref.row !== null && ref.row !== row) row = ref.row;
				cell = { column, type: attrs.t ?? "n", style: Number(attrs.s ?? 0) };
				value = "";
				inline = "";
			} else if (cell && name === "v") {
				capture = "v";
			} else if (cell && name === "is") {
				inInline = true;
			} else if (inInline && name === "rPh") {
				phonetic++;
			} else if (inInline && phonetic === 0 && name === "t") {
				capture = "t";
			}
			return undefined;
		},
		text: text => {
			if (capture === "v") value += text;
			else if (capture === "t") inline += text;
			return undefined;
		},
		close: name => {
			if (name === "v" || name === "t") capture = null;
			else if (name === "rPh") phonetic = Math.max(0, phonetic - 1);
			else if (name === "is") inInline = false;
			else if (name === "c" && cell) {
				const display = cellDisplay(cell.type, cell.style, value, inline, context);
				if (display.text !== "") {
					if (row > caps.rows) {
						// Rows come in order: everything further is past the cap too.
						clippedRows = true;
						return false;
					}
					if (cell.column > caps.columns) {
						clippedColumns = true;
					} else {
						let cellsInRow = cells.get(row);
						if (!cellsInRow) {
							cellsInRow = new Map();
							cells.set(row, cellsInRow);
						}
						cellsInRow.set(cell.column, display);
						lastRow = Math.max(lastRow, row);
						lastColumn = Math.max(lastColumn, cell.column);
					}
				}
				cell = null;
			}
			return undefined;
		},
	});

	const empty: SheetCell = { text: "", numeric: false };
	const rows = Array.from({ length: lastRow }, (_, r) => {
		const cellsInRow = cells.get(r + 1);
		return Array.from({ length: lastColumn }, (_, c) => cellsInRow?.get(c + 1) ?? empty);
	});
	return { rows, columns: lastColumn, clippedRows, clippedColumns };
}

function cellDisplay(type: string, style: number, value: string, inline: string, context: SheetContext): SheetCell {
	switch (type) {
		case "s":
			return { text: context.sharedStrings[Number(value)] ?? "", numeric: false };
		case "inlineStr":
			return { text: unescapeExcel(inline), numeric: false };
		case "str":
			return { text: unescapeExcel(value), numeric: false };
		case "b":
			return { text: value === "" ? "" : value === "1" || value === "true" ? "TRUE" : "FALSE", numeric: false };
		case "e":
		case "d":
			return { text: value, numeric: false };
		default: {
			const number = Number(value);
			if (value.trim() === "" || !Number.isFinite(number)) return { text: value, numeric: false };
			return {
				text: formatNumber(number, context.formats[style] ?? "General", context.date1904),
				numeric: true,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Number formats

type FormatToken =
	| { kind: "literal"; text: string }
	| { kind: "code"; text: string }
	| { kind: "elapsed"; unit: "h" | "m" | "s" };

/** Splits a format code at unquoted, unescaped `;`. */
function formatSections(code: string): string[] {
	const sections: string[] = [];
	let current = "";
	let quoted = false;
	let bracket = false;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === "\\" && !quoted) {
			current += ch + (code[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === "[") bracket = true;
		else if (!quoted && ch === "]") bracket = false;
		if (ch === ";" && !quoted && !bracket) {
			sections.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	sections.push(current);
	return sections;
}

/** One section into literal text and format characters; colors, conditions and locale tags dropped. */
function tokenizeFormat(section: string): FormatToken[] {
	const tokens: FormatToken[] = [];
	const push = (token: FormatToken) => {
		const last = tokens[tokens.length - 1];
		if (last && last.kind === token.kind && token.kind !== "elapsed" && last.kind !== "elapsed") {
			last.text += token.text;
		} else {
			tokens.push(token);
		}
	};
	for (let i = 0; i < section.length; i++) {
		const ch = section[i];
		if (ch === '"') {
			const end = section.indexOf('"', i + 1);
			push({ kind: "literal", text: section.slice(i + 1, end === -1 ? undefined : end) });
			i = end === -1 ? section.length : end;
		} else if (ch === "\\") {
			push({ kind: "literal", text: section[i + 1] ?? "" });
			i++;
		} else if (ch === "_") {
			// Space as wide as the next character (alignment padding).
			push({ kind: "literal", text: " " });
			i++;
		} else if (ch === "*") {
			// Fill character: repeats to the column width; nothing in a preview.
			i++;
		} else if (ch === "[") {
			const end = section.indexOf("]", i + 1);
			const inner = section.slice(i + 1, end === -1 ? undefined : end);
			i = end === -1 ? section.length : end;
			const elapsed = /^(h+|m+|s+)$/i.exec(inner);
			const currency = /^\$([^-]*)/.exec(inner);
			if (elapsed) {
				const unit = inner[0].toLowerCase();
				tokens.push({ kind: "elapsed", unit: unit === "h" ? "h" : unit === "m" ? "m" : "s" });
			} else if (currency) {
				push({ kind: "literal", text: currency[1] });
			}
		} else if (/[0#?.,%Ee+\-/:yYmMdDhHsSaApP@ ]/.test(ch) || /[A-Za-z]/.test(ch)) {
			push({ kind: "code", text: ch });
		} else {
			push({ kind: "literal", text: ch });
		}
	}
	return tokens;
}

/** Excel's General: integers as is, otherwise about ten significant digits. */
function formatGeneral(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude !== 0 && (magnitude >= 1e11 || magnitude < 1e-9)) {
		const [mantissa, exponent] = value.toExponential(5).split("e");
		const sign = exponent.startsWith("-") ? "-" : "+";
		const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
		return `${mantissa.replace(/\.?0+$/, "")}E${sign}${digits}`;
	}
	if (Number.isInteger(value)) return String(value);
	return String(Number(value.toPrecision(10)));
}

export function formatNumber(value: number, code: string, date1904 = false): string {
	const sections = formatSections(code);
	let section = sections[0] ?? "General";
	let number = value;
	let sign = "";
	if (value < 0 && sections.length > 1 && sections[1] !== "") {
		// The negative section spells its own sign (parentheses, a leading "-").
		section = sections[1];
		number = -value;
	} else if (value === 0 && sections.length > 2 && sections[2] !== "") {
		section = sections[2];
	} else if (value < 0) {
		sign = "-";
		number = -value;
	}
	const tokens = tokenizeFormat(section);
	const codeText = tokens.map(token => (token.kind === "code" ? token.text : "")).join("");
	if (codeText.trim() === "" && tokens.every(token => token.kind !== "elapsed")) {
		// Literal-only section: the literal is the display.
		return tokens.map(token => (token.kind === "literal" ? token.text : "")).join("");
	}
	if (/general/i.test(codeText) || codeText.trim() === "@") return sign + formatGeneral(number);
	const isDate =
		tokens.some(token => token.kind === "elapsed") ||
		/[yYdDhHsS]/.test(codeText) ||
		/^[^0#?]*[mM][^0#?]*$/.test(codeText);
	if (isDate) return formatDate(value, tokens, date1904);
	// Fractions (`# ?/?`) are rare in practice; show the plain number.
	if (/[?]\/[?\d]/.test(codeText)) return sign + formatGeneral(number);
	return sign + formatNumeric(number, tokens);
}

function formatNumeric(value: number, tokens: FormatToken[]): string {
	// Character pieces so literals and `%` around the digits stay where they are written.
	const pieces = tokens.flatMap(token =>
		token.kind === "literal"
			? [{ literal: true, ch: token.text }]
			: token.kind === "code"
				? [...token.text].map(ch => ({ literal: false, ch }))
				: [],
	);
	const isDigit = (piece: { literal: boolean; ch: string }) => !piece.literal && /[0#?]/.test(piece.ch);
	const first = pieces.findIndex(isDigit);
	const last = pieces.findLastIndex(isDigit);
	if (first === -1) return formatGeneral(value);
	const outside = (part: typeof pieces) =>
		part.map(piece => (piece.literal ? piece.ch : piece.ch === "," ? "" : piece.ch)).join("");
	const numberPart = pieces
		.slice(first, last + 1)
		.filter(piece => !piece.literal)
		.map(piece => piece.ch)
		.join("");
	const percents = pieces.filter(piece => !piece.literal && piece.ch === "%").length;
	// Commas right after the last digit placeholder scale by a thousand each.
	let trailingCommas = 0;
	while (pieces[last + 1 + trailingCommas]?.ch === "," && !pieces[last + 1 + trailingCommas].literal) trailingCommas++;
	const scaled = (value * 100 ** percents) / 1000 ** trailingCommas;

	const exponent = /[Ee][+-]/.exec(numberPart);
	const mantissaPart = exponent ? numberPart.slice(0, exponent.index) : numberPart;
	const dot = mantissaPart.indexOf(".");
	const integerPart = dot === -1 ? mantissaPart : mantissaPart.slice(0, dot);
	const decimals = dot === -1 ? 0 : (mantissaPart.slice(dot + 1).match(/[0#?]/g)?.length ?? 0);
	// `#` decimals are optional: 0.5 in `0.##` shows as "0.5", not "0.50".
	const requiredDecimals = dot === -1 ? 0 : (mantissaPart.slice(dot + 1).match(/0/g)?.length ?? 0);

	let body: string;
	if (exponent) {
		const exponentDigits = numberPart.slice(exponent.index + 2).replace(/[^0#?]/g, "").length || 1;
		const [mantissa, power] = scaled.toExponential(decimals).split("e");
		const powerValue = Number(power);
		const powerSign = powerValue < 0 ? "-" : exponent[0][1] === "+" ? "+" : "";
		body = `${mantissa}E${powerSign}${String(Math.abs(powerValue)).padStart(exponentDigits, "0")}`;
	} else {
		body = new Intl.NumberFormat("en-US", {
			minimumFractionDigits: requiredDecimals,
			maximumFractionDigits: decimals,
			useGrouping: integerPart.includes(","),
		}).format(scaled);
		// `#.##` has no required integer digit: 0.5 shows as ".5".
		if (!integerPart.includes("0") && body.startsWith("0.")) body = body.slice(1);
	}
	return outside(pieces.slice(0, first)) + body + outside(pieces.slice(last + 1));
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Serial day number → UTC calendar parts (Excel's 1900 system keeps its fictitious 1900-02-29). */
function serialParts(serial: number, date1904: boolean) {
	let days = Math.floor(serial);
	let seconds = Math.round((serial - days) * 86_400);
	if (seconds >= 86_400) {
		days += 1;
		seconds -= 86_400;
	}
	const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
	const date = new Date(epoch + days * 86_400_000);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth(),
		day: date.getUTCDate(),
		weekday: date.getUTCDay(),
		hours: Math.floor(seconds / 3600),
		minutes: Math.floor(seconds / 60) % 60,
		seconds: seconds % 60,
		fraction: serial - Math.floor(serial),
	};
}

function formatDate(serial: number, tokens: FormatToken[], date1904: boolean): string {
	const parts = serialParts(Math.abs(serial), date1904);
	const twelveHour = tokens.some(token => token.kind === "code" && /AM\/PM|A\/P/i.test(token.text));
	// Split code runs into date words (yyyy, mm, AM/PM…) so `m` can be read as month or minute.
	type Word = { kind: "literal"; text: string } | { kind: "word"; text: string } | FormatToken;
	const words: Word[] = [];
	for (const token of tokens) {
		if (token.kind !== "code") {
			words.push(token);
			continue;
		}
		for (const match of token.text.matchAll(/AM\/PM|A\/P|y+|m+|d+|h+|s+|\.0+|./gi)) {
			const text = match[0];
			const previous = words.findLast(word => word.kind === "word");
			// `.0` is fractional seconds only right after a seconds word; elsewhere a literal dot.
			const isWord = text.startsWith(".")
				? previous?.kind === "word" && previous.text[0].toLowerCase() === "s"
				: /^(AM\/PM|A\/P|y+|m+|d+|h+|s+)$/i.test(text);
			words.push({ kind: isWord ? "word" : "literal", text });
		}
	}
	const unitOf = (word: Word | undefined) =>
		word?.kind === "word" ? word.text[0].toLowerCase() : word?.kind === "elapsed" ? word.unit : null;
	const dateWords = words.filter(word => word.kind === "word" || word.kind === "elapsed");

	let out = "";
	for (const word of words) {
		if (word.kind === "literal") {
			out += word.text;
			continue;
		}
		if (word.kind === "elapsed") {
			const total = Math.floor(Math.round(Math.abs(serial) * 86_400));
			out += String(
				word.unit === "h" ? Math.floor(total / 3600) : word.unit === "m" ? Math.floor(total / 60) : total,
			);
			continue;
		}
		if (word.kind !== "word") continue;
		const text = word.text;
		const lower = text.toLowerCase();
		const position = dateWords.indexOf(word);
		if (lower[0] === "y") {
			out += lower.length <= 2 ? String(parts.year % 100).padStart(2, "0") : String(parts.year);
		} else if (lower[0] === "m") {
			const before = unitOf(dateWords[position - 1]);
			const after = unitOf(dateWords[position + 1]);
			const minute = lower.length <= 2 && (before === "h" || after === "s");
			if (minute) out += lower.length === 2 ? String(parts.minutes).padStart(2, "0") : String(parts.minutes);
			else if (lower.length === 1) out += String(parts.month + 1);
			else if (lower.length === 2) out += String(parts.month + 1).padStart(2, "0");
			else if (lower.length === 3) out += MONTHS[parts.month].slice(0, 3);
			else if (lower.length === 4) out += MONTHS[parts.month];
			else out += MONTHS[parts.month][0];
		} else if (lower[0] === "d") {
			if (lower.length === 1) out += String(parts.day);
			else if (lower.length === 2) out += String(parts.day).padStart(2, "0");
			else if (lower.length === 3) out += WEEKDAYS[parts.weekday].slice(0, 3);
			else out += WEEKDAYS[parts.weekday];
		} else if (lower[0] === "h") {
			const hours = twelveHour ? parts.hours % 12 || 12 : parts.hours;
			out += lower.length >= 2 ? String(hours).padStart(2, "0") : String(hours);
		} else if (lower[0] === "s") {
			out += lower.length >= 2 ? String(parts.seconds).padStart(2, "0") : String(parts.seconds);
		} else if (lower.startsWith(".")) {
			const digits = lower.length - 1;
			const fraction = (parts.fraction * 86_400) % 1;
			out += `.${String(Math.round(fraction * 10 ** digits))
				.padStart(digits, "0")
				.slice(0, digits)}`;
		} else if (lower === "am/pm") {
			out += parts.hours < 12 ? "AM" : "PM";
		} else if (lower === "a/p") {
			out += parts.hours < 12 ? "A" : "P";
		}
	}
	return out;
}
