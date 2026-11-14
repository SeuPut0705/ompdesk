/**
 * A small PNG decoder for `NativeImage#toBitmap()`: the captures the shell makes are non-interlaced 8-bit PNGs
 * (Chromium's `Page.captureScreenshot`); gray, gray+alpha, palette, RGB and RGBA at 8 bits are read, anything else
 * throws.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Row-major 8-bit RGBA, not premultiplied. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Buffer } {
	const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG");
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette = Buffer.alloc(0);
	let transparency = Buffer.alloc(0);
	const idat: Buffer[] = [];
	for (let offset = 8; offset + 8 <= data.length; ) {
		const length = data.readUInt32BE(offset);
		const type = data.toString("latin1", offset + 4, offset + 8);
		const body = data.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8];
			colorType = body[9];
			interlace = body[12];
		} else if (type === "PLTE") palette = Buffer.from(body);
		else if (type === "tRNS") transparency = Buffer.from(body);
		else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	if (depth !== 8 || interlace !== 0)
		throw new Error(`PNG with bit depth ${depth}${interlace ? ", interlaced" : ""} is not supported`);
	const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
	if (channels === undefined) throw new Error(`PNG color type ${colorType} is not supported`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rows = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = rows.subarray(y * stride, (y + 1) * stride);
		const above = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
		for (let x = 0; x < stride; x += 1) {
			const left = x >= channels ? out[x - channels] : 0;
			const up = above ? above[x] : 0;
			const upLeft = above && x >= channels ? above[x - channels] : 0;
			let predictor = 0;
			if (filter === 1) predictor = left;
			else if (filter === 2) predictor = up;
			else if (filter === 3) predictor = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			} else if (filter !== 0) throw new Error(`PNG filter ${filter} is not valid`);
			out[x] = (line[x] + predictor) & 0xff;
		}
	}
	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i += 1) {
		const source = i * channels;
		let r: number;
		let g: number;
		let b: number;
		let a = 255;
		if (colorType === 6) [r, g, b, a] = [rows[source], rows[source + 1], rows[source + 2], rows[source + 3]];
		else if (colorType === 2) [r, g, b] = [rows[source], rows[source + 1], rows[source + 2]];
		else if (colorType === 0) r = g = b = rows[source];
		else if (colorType === 4) {
			r = g = b = rows[source];
			a = rows[source + 1];
		} else {
			const index = rows[source];
			[r, g, b] = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
			a = index < transparency.length ? transparency[index] : 255;
		}
		rgba.set([r, g, b, a], i * 4);
	}
	return { width, height, rgba };
}

/** Electron's `toBitmap()`: BGRA, premultiplied alpha, row-major. */
export function bgraPremultiplied(rgba: Buffer): Buffer {
	const bitmap = Buffer.alloc(rgba.length);
	for (let i = 0; i < rgba.length; i += 4) {
		const alpha = rgba[i + 3];
		const scale = alpha / 255;
		bitmap[i] = Math.round(rgba[i + 2] * scale);
		bitmap[i + 1] = Math.round(rgba[i + 1] * scale);
		bitmap[i + 2] = Math.round(rgba[i] * scale);
		bitmap[i + 3] = alpha;
	}
	return bitmap;
}
