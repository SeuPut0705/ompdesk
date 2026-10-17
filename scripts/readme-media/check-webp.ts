/**
 * Plays every `docs/media/*.webp` the way the README does: as an `<img>` in Chromium. Each file must decode at the
 * size its WebP header states (and 1600 px wide, or 780 for the phone, for a clip), and an animated one must show
 * different, non-blank frames at 0, ~40% and ~80% of its duration. The screenshots go to /tmp/readme-webp-check/.
 *
 *   bun scripts/readme-media/check-webp.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const MEDIA = path.resolve(import.meta.dirname, "../../docs/media");
const OUT = "/tmp/readme-webp-check";

/** Canvas size and total duration (ms) from the RIFF/VP8X header and the ANMF chunks. */
function inspect(file: string): { width: number; height: number; frames: number; ms: number } {
	const bytes = fs.readFileSync(file);
	const extended = bytes.toString("ascii", 12, 16) === "VP8X";
	// A still written by cwebp is a plain "VP8 " chunk: its frame header holds 14-bit width and height.
	const width = extended ? 1 + bytes.readUIntLE(24, 3) : bytes.readUInt16LE(26) & 0x3fff;
	const height = extended ? 1 + bytes.readUIntLE(27, 3) : bytes.readUInt16LE(28) & 0x3fff;
	let frames = 0;
	let ms = 0;
	for (let at = 12; at + 8 <= bytes.length; ) {
		const size = bytes.readUInt32LE(at + 4);
		if (bytes.toString("ascii", at, at + 4) === "ANMF") {
			frames++;
			ms += bytes.readUIntLE(at + 8 + 12, 3);
		}
		at += 8 + size + (size % 2);
	}
	return { width, height, frames, ms };
}

const problems: string[] = [];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
	for (const name of fs
		.readdirSync(MEDIA)
		.filter(file => file.endsWith(".webp"))
		.sort()) {
		const file = path.join(MEDIA, name);
		const { width, height, frames, ms } = inspect(file);
		const clip = frames > 1;
		if (clip && width !== (name.startsWith("phone") ? 780 : 1600)) problems.push(`${name}: ${width} px wide`);
		const page = await browser.newPage({ viewport: { width, height } });
		const html = path.join(OUT, `${name}.html`);
		fs.writeFileSync(html, `<body style="margin:0;background:#fff"><img id="i" src="file://${file}"></body>`);
		await page.goto(`file://${html}`);
		const size = await page.evaluate(async () => {
			const img = document.getElementById("i") as HTMLImageElement;
			await img.decode();
			return { w: img.naturalWidth, h: img.naturalHeight };
		});
		if (size.w !== width || size.h !== height)
			problems.push(`${name}: decoded ${size.w}x${size.h}, header says ${width}x${height}`);
		const shots: Buffer[] = [];
		const started = Date.now();
		for (const at of clip ? [0, 0.4, 0.8] : [0]) {
			const wait = at * ms - (Date.now() - started);
			if (wait > 0) await page.waitForTimeout(wait);
			const shot = await page.locator("#i").screenshot();
			fs.writeFileSync(path.join(OUT, `${name.replace(".webp", "")}-${Math.round(at * 100)}.png`), shot);
			shots.push(shot);
			const { channels } = await sharp(shot).stats();
			const spread = Math.max(...channels.map(channel => channel.stdev));
			if (spread < 5)
				problems.push(`${name}: the frame at ${Math.round(at * 100)}% looks blank (stdev ${spread.toFixed(1)})`);
		}
		if (clip) {
			for (let i = 1; i < shots.length; i++) {
				const [a, b] = [shots[i - 1], shots[i]] as [Buffer, Buffer];
				if (a.equals(b))
					problems.push(`${name}: frames ${i - 1} and ${i} are identical, the clip does not animate`);
			}
		}
		console.log(`${name}: ${width}x${height}, ${frames} frame(s), ${(ms / 1000).toFixed(1)} s`);
		await page.close();
	}
} finally {
	await browser.close();
}
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`Every WebP decodes and plays; screenshots are in ${OUT}.`);
