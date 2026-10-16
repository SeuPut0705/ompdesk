/**
 * Rasterize the installed web app's icons from the brand mark (scripts/brand-svgs.ts `PWA_ICON_SVGS`) into
 * src/renderer/public/: `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png` (the manifest's
 * icons) and `apple-touch-icon.png` (180, opaque; iOS asks for it at the site root). `bun run gen:icons` calls
 * `writePwaIcons`; `bun scripts/pwa-icons.ts` writes only these.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import { PWA_ICON_FILES, PWA_ICON_SVGS } from "./brand-svgs";

const PUBLIC_DIR = path.join(import.meta.dir, "..", "src", "renderer", "public");

export async function writePwaIcons(): Promise<void> {
	for (const { file, source, size } of PWA_ICON_FILES) {
		const png = await sharp(Buffer.from(PWA_ICON_SVGS[source]), { density: Math.ceil((72 * size * 2) / 512) })
			.resize(size, size)
			.png({ compressionLevel: 9 })
			.toBuffer();
		const target = path.join(PUBLIC_DIR, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, png);
	}
}

if (import.meta.main) {
	await writePwaIcons();
	console.log(`Wrote ${PWA_ICON_FILES.length} web app icons to src/renderer/public/`);
}
