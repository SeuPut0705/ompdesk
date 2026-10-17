/**
 * Dump evenly spaced frames of a produced clip as PNGs, to look at what the README will show:
 *
 *   bun scripts/readme-media/frames.ts docs/media/hero.webp <outDir> [count=6] [width=1000]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";

const [file, outDir, countArg, widthArg] = process.argv.slice(2);
if (!file || !outDir) throw new Error("usage: frames.ts <clip.webp> <outDir> [count] [width]");
const count = Number(countArg ?? 6);
const width = Number(widthArg ?? 1000);
fs.mkdirSync(outDir, { recursive: true });
const { pages = 1 } = await sharp(file, { pages: -1 }).metadata();
const base = path.basename(file, ".webp");
for (let n = 0; n < count; n++) {
	const page = pages === 1 ? 0 : Math.round((n * (pages - 1)) / Math.max(count - 1, 1));
	await sharp(file, { page })
		.resize(width)
		.png()
		.toFile(path.join(outDir, `${base}-${String(n).padStart(2, "0")}.png`));
}
console.log(`${base}: ${pages} frames, wrote ${count} to ${outDir}`);
