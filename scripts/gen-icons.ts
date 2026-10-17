/**
 * Generate every brand asset from the π geometry in src/shared/brand-mark.ts:
 * - writes the SVGs in scripts/brand-svgs.ts (resources/icon-source*.svg,
 *   resources/brand/*.svg) and, into src/renderer/index.html and web.html, the
 *   favicon data URL and the first-paint mark (`brandHtml`), then rasterizes the SVGs:
 * - icon-source.svg → icon.png (1024px master: dev dock icon); on macOS,
 *   icon.icns (via an iconset + iconutil) from icon-source.svg above 48px and
 *   icon-source-small.svg at 48px and below.
 * - brand/mark-tile.svg / mark-tile-small.svg (same size split) → icon.ico
 *   (full-bleed tile, Windows); mark-tile-small.svg → brand/tray.png + tray@2x.png
 *   (Windows tray); mark-tile.svg → brand/app-icon.png (256px: the window,
 *   About panel and Windows notification icon).
 * - brand/mark-mono.svg → brand/trayTemplate.png + trayTemplate@2x.png
 *   (macOS menu-bar template: monochrome, alpha only; the system tints it).
 * - brand/social-preview.svg → brand/social-preview.png (GitHub's 1280×640
 *   repository social preview; upload it in Settings › Social preview).
 * - brand/dmg-background.svg → dmg-background.tiff (1x + 2x, macOS only: the
 *   DMG window, electron-builder.yml `dmg.background`).
 * - PWA_ICON_SVGS → src/renderer/public/icons/*.png and apple-touch-icon.png (the installed web app's
 *   icons and notification badge, scripts/pwa-icons.ts).
 * Run: `bun run gen:icons`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { BRAND_MARK } from "../src/shared/brand-mark";
import { BRAND_SVGS, brandHtml, DMG_BACKGROUND } from "./brand-svgs";
import { writePwaIcons } from "./pwa-icons";

const resources = path.join(import.meta.dir, "..", "resources");
const rendererDir = path.join(import.meta.dir, "..", "src", "renderer");
/** The two page shells: the desktop window and the paired phone's. */
const RENDERER_PAGES = [path.join(rendererDir, "index.html"), path.join(rendererDir, "web.html")];
const brand = path.join(resources, "brand");
const iconset = path.join(resources, "icon.iconset");
/** The 256 px window / About / notification icon. */
const APP_ICON_PX = 256;

// (name, px) pairs for the macOS iconset; @2x entries are double resolution.
const ICONSET: [string, number][] = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Menu-bar / notification-area icon size in points; @2x is double. */
const TRAY_POINTS = 16;
const WIN_TRAY_PX = 16;

async function render(svg: Buffer, size: number): Promise<Buffer> {
	// Rasterize well above the target size so the vector stays crisp when resized down.
	const { width = size } = await sharp(svg).metadata();
	const density = Math.min(2400, Math.max(72, Math.ceil((72 * size * 4) / width)));
	return sharp(svg, { density })
		.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();
}

async function writeIco(frames: { size: number; data: Buffer }[], outPath: string): Promise<void> {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(frames.length, 4);
	const entries = Buffer.alloc(16 * frames.length);
	const blobs: Buffer[] = [];
	let offset = header.length + entries.length;
	for (const [index, frame] of frames.entries()) {
		const width = frame.size >= 256 ? 0 : frame.size;
		entries.writeUInt8(width, index * 16);
		entries.writeUInt8(width, index * 16 + 1);
		entries.writeUInt16LE(1, index * 16 + 4);
		entries.writeUInt16LE(32, index * 16 + 6);
		entries.writeUInt32LE(frame.data.length, index * 16 + 8);
		entries.writeUInt32LE(offset, index * 16 + 12);
		blobs.push(frame.data);
		offset += frame.data.length;
	}
	await Bun.write(outPath, Buffer.concat([header, entries, ...blobs]));
}

/** A non-square SVG rasterized at `width` × `height` (the density scales its own size up to that). */
async function renderBox(svg: Buffer, width: number, height: number): Promise<sharp.Sharp> {
	const { width: own = width } = await sharp(svg).metadata();
	return sharp(svg, { density: Math.ceil((72 * width) / own) }).resize(width, height);
}

/** The DMG window picture as a two-resolution TIFF (Finder picks the 144 dpi frame on Retina). macOS only: tiffutil. */
async function writeDmgBackground(svg: Buffer): Promise<void> {
	const { width, height } = DMG_BACKGROUND;
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-dmg-"));
	try {
		const frames = [path.join(tmp, "1x.tiff"), path.join(tmp, "2x.tiff")];
		await (await renderBox(svg, width, height)).withMetadata({ density: 72 }).tiff().toFile(frames[0]);
		await (await renderBox(svg, width * 2, height * 2)).withMetadata({ density: 144 }).tiff().toFile(frames[1]);
		execFileSync(
			"tiffutil",
			["-cathidpicheck", frames[0], frames[1], "-out", path.join(resources, "dmg-background.tiff")],
			{ stdio: "inherit" },
		);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	for (const [file, contents] of Object.entries(BRAND_SVGS)) await Bun.write(path.join(resources, file), contents);
	for (const page of RENDERER_PAGES) await Bun.write(page, brandHtml(await Bun.file(page).text()));
	const source = (file: string) => Buffer.from(BRAND_SVGS[file]);
	const small = (px: number) => px <= BRAND_MARK.smallMaxPx;
	const appIcon = source("icon-source.svg");
	const appIconSmall = source("icon-source-small.svg");
	const tile = source("brand/mark-tile.svg");
	const tileSmall = source("brand/mark-tile-small.svg");
	const mono = source("brand/mark-mono.svg");

	await Bun.write(path.join(resources, "icon.png"), await render(appIcon, 1024));

	if (process.platform === "darwin") {
		await fs.rm(iconset, { recursive: true, force: true });
		await fs.mkdir(iconset, { recursive: true });
		for (const [name, px] of ICONSET) {
			await Bun.write(path.join(iconset, name), await render(small(px) ? appIconSmall : appIcon, px));
		}
		execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "icon.icns")], { stdio: "inherit" });
		await fs.rm(iconset, { recursive: true, force: true });
	} else {
		console.warn("Skipping icon.icns: iconutil is macOS-only.");
	}

	const icoFrames = await Promise.all(
		ICO_SIZES.map(async size => ({ size, data: await render(small(size) ? tileSmall : tile, size) })),
	);
	await writeIco(icoFrames, path.join(resources, "icon.ico"));

	await Bun.write(path.join(brand, "trayTemplate.png"), await render(mono, TRAY_POINTS));
	await Bun.write(path.join(brand, "trayTemplate@2x.png"), await render(mono, TRAY_POINTS * 2));
	await Bun.write(path.join(brand, "tray.png"), await render(tileSmall, WIN_TRAY_PX));
	await Bun.write(path.join(brand, "tray@2x.png"), await render(tileSmall, WIN_TRAY_PX * 2));
	// The window, About panel and Windows notification icon (a file: packaged apps ship it in resources/).
	await Bun.write(path.join(brand, "app-icon.png"), await render(tile, APP_ICON_PX));
	await Bun.write(
		path.join(brand, "social-preview.png"),
		await (await renderBox(source("brand/social-preview.svg"), 1280, 640)).png({ compressionLevel: 9 }).toBuffer(),
	);
	if (process.platform === "darwin") await writeDmgBackground(source("brand/dmg-background.svg"));
	else console.warn("Skipping dmg-background.tiff: tiffutil is macOS-only.");
	await writePwaIcons();

	console.log("Generated brand SVGs, icon.png, icon.icns (macOS), icon.ico, brand/*.png and dmg-background.tiff");
}

await main();
