/**
 * Generate every raster brand asset from the hand-written SVGs:
 * - resources/icon-source.svg → icon.png (1024px master: dev dock icon) and,
 *   on macOS, icon.icns (via an iconset + iconutil).
 * - resources/brand/mark-tile.svg → icon.ico (full-bleed tile, Windows) and
 *   brand/tray.png + tray@2x.png (Windows tray).
 * - resources/brand/mark-mono.svg → brand/trayTemplate.png + trayTemplate@2x.png
 *   (macOS menu-bar template: monochrome, alpha only; the system tints it).
 * Run: `bun run gen:icons`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

const resources = path.join(import.meta.dir, "..", "resources");
const brand = path.join(resources, "brand");
const iconset = path.join(resources, "icon.iconset");

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
const TRAY_POINTS = 18;
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

async function main(): Promise<void> {
	const appIcon = await fs.readFile(path.join(resources, "icon-source.svg"));
	const tile = await fs.readFile(path.join(brand, "mark-tile.svg"));
	const mono = await fs.readFile(path.join(brand, "mark-mono.svg"));

	await Bun.write(path.join(resources, "icon.png"), await render(appIcon, 1024));

	if (process.platform === "darwin") {
		await fs.rm(iconset, { recursive: true, force: true });
		await fs.mkdir(iconset, { recursive: true });
		for (const [name, px] of ICONSET) {
			await Bun.write(path.join(iconset, name), await render(appIcon, px));
		}
		execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "icon.icns")], { stdio: "inherit" });
		await fs.rm(iconset, { recursive: true, force: true });
	} else {
		console.warn("Skipping icon.icns: iconutil is macOS-only.");
	}

	const icoFrames = await Promise.all(ICO_SIZES.map(async size => ({ size, data: await render(tile, size) })));
	await writeIco(icoFrames, path.join(resources, "icon.ico"));

	await Bun.write(path.join(brand, "trayTemplate.png"), await render(mono, TRAY_POINTS));
	await Bun.write(path.join(brand, "trayTemplate@2x.png"), await render(mono, TRAY_POINTS * 2));
	await Bun.write(path.join(brand, "tray.png"), await render(tile, WIN_TRAY_PX));
	await Bun.write(path.join(brand, "tray@2x.png"), await render(tile, WIN_TRAY_PX * 2));

	console.log("Generated icon.png, icon.icns (macOS), icon.ico, and brand/tray*.png");
}

await main();
