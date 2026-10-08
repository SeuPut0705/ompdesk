/**
 * Pure parsers behind the Files drawer viewers: delimited tables (RFC 4180
 * quoting), JSON / JSON Lines pretty-printing, Jupyter notebooks, and the hex
 * dump. No React here, so each is unit-testable on its own.
 */
import { z } from "zod";

export interface DelimitedTable {
	rows: string[][];
	/** Rows past `maxRows` exist and were not parsed. */
	clipped: boolean;
}

/**
 * Parse CSV/TSV: fields may be quoted ("a, b"), quotes double inside quotes
 * (""), and a quoted field may span lines. CRLF and LF both end a row.
 * Stops after `maxRows` rows.
 */
export function parseDelimited(text: string, delimiter: string, maxRows: number): DelimitedTable {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endRow = () => {
		row.push(field);
		rows.push(row);
		row = [];
		field = "";
	};
	while (i < text.length) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else {
				field += ch;
			}
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
		} else if (ch === delimiter) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			endRow();
			if (rows.length >= maxRows) return { rows, clipped: i + 1 < text.length };
		} else {
			field += ch;
		}
		i++;
	}
	if (field !== "" || row.length > 0) endRow();
	return { rows, clipped: false };
}

/** Pretty JSON, or each JSON Lines record pretty-printed; null when any part fails to parse. */
export function prettyJson(text: string, lines: boolean): string | null {
	try {
		if (!lines) return JSON.stringify(JSON.parse(text), null, 2);
		return text
			.split(/\r?\n/)
			.filter(line => line.trim() !== "")
			.map(line => JSON.stringify(JSON.parse(line), null, 2))
			.join("\n");
	} catch {
		return null;
	}
}

export type NotebookOutput =
	| { kind: "text"; text: string }
	| { kind: "image"; mime: "image/png" | "image/jpeg" | "image/gif"; base64: string };

export type NotebookCell =
	| { kind: "markdown"; source: string }
	| { kind: "code"; source: string; executionCount: number | null; outputs: NotebookOutput[] }
	| { kind: "raw"; source: string };

export interface Notebook {
	language: string;
	cells: NotebookCell[];
}

/** nbformat multiline strings are a string or a list of line strings. */
const MultilineText = z.union([z.string(), z.array(z.string()).transform(parts => parts.join(""))]);

/** Per-output and per-cell schemas parse independently: one odd output must not hide the notebook. */
const NotebookOutputSchema = z.object({
	output_type: z.string(),
	text: MultilineText.optional(),
	traceback: z.array(z.string()).optional(),
	ename: z.string().optional(),
	evalue: z.string().optional(),
	data: z.record(z.unknown()).optional(),
});

const NotebookCellSchema = z.object({
	cell_type: z.string(),
	source: MultilineText.catch(""),
	execution_count: z.number().nullable().catch(null),
	outputs: z.array(z.unknown()).catch([]),
});

const NotebookSchema = z.object({
	cells: z.array(z.unknown()),
	metadata: z
		.object({
			language_info: z.object({ name: z.string() }).partial().catch({}),
			kernelspec: z.object({ language: z.string() }).partial().catch({}),
		})
		.partial()
		.catch({}),
});

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"] as const;

function parseOutput(raw: unknown): NotebookOutput[] {
	const parsed = NotebookOutputSchema.safeParse(raw);
	if (!parsed.success) return [];
	const output = parsed.data;
	switch (output.output_type) {
		case "stream":
			return [{ kind: "text", text: output.text ?? "" }];
		case "error":
			return [
				{
					kind: "text",
					text: output.traceback?.join("\n") ?? `${output.ename ?? "Error"}: ${output.evalue ?? ""}`,
				},
			];
		case "execute_result":
		case "display_data": {
			const data = output.data ?? {};
			for (const mime of IMAGE_MIMES) {
				const value = MultilineText.safeParse(data[mime]);
				// Base64 alphabet only: the payload becomes a data: URL.
				const base64 = value.success ? value.data.replace(/\s+/g, "") : "";
				if (base64 && /^[A-Za-z0-9+/]+=*$/.test(base64)) return [{ kind: "image", mime, base64 }];
			}
			const text = MultilineText.safeParse(data["text/plain"]);
			return text.success && text.data ? [{ kind: "text", text: text.data }] : [];
		}
		default:
			return [];
	}
}

/** Parse an .ipynb document; null when it isn't a notebook. */
export function parseNotebook(text: string): Notebook | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = NotebookSchema.safeParse(raw);
	if (!parsed.success) return null;
	const { cells: rawCells, metadata } = parsed.data;
	const language = metadata?.language_info?.name ?? metadata?.kernelspec?.language ?? "python";
	const cells: NotebookCell[] = [];
	for (const rawCell of rawCells) {
		const parsedCell = NotebookCellSchema.safeParse(rawCell);
		if (!parsedCell.success) continue;
		const cell = parsedCell.data;
		if (cell.cell_type === "markdown") cells.push({ kind: "markdown", source: cell.source });
		else if (cell.cell_type === "code")
			cells.push({
				kind: "code",
				source: cell.source,
				executionCount: cell.execution_count,
				outputs: cell.outputs.flatMap(parseOutput),
			});
		else cells.push({ kind: "raw", source: cell.source });
	}
	return { language, cells };
}

/** Classic `hexdump -C` layout: offset, 16 hex bytes in two groups, printable ASCII. */
export function hexDump(data: Uint8Array): string {
	const lines: string[] = [];
	for (let offset = 0; offset < data.length; offset += 16) {
		let hex = "";
		let ascii = "";
		for (let i = 0; i < 16; i++) {
			const byte = data[offset + i];
			if (i === 8) hex += " ";
			if (byte === undefined) {
				hex += "   ";
				continue;
			}
			hex += `${byte.toString(16).padStart(2, "0")} `;
			ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
		}
		lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex} |${ascii}|`);
	}
	return lines.join("\n");
}
