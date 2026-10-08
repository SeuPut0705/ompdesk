import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

/** A one-page PDF with real text and a filled bar, offsets computed so pdf.js needs no xref repair. */
export function tinyPdf(): Buffer {
	const content = "0 0.45 0.9 rg 40 40 220 30 re f BT /F1 24 Tf 40 110 Td (Hello PDF) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
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
	};
	await Promise.all(Object.entries(files).map(([name, data]) => fs.writeFile(path.join(dir, name), data)));
	return Object.keys(files);
}
