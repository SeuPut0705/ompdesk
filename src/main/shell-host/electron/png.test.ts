import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { NativeImage } from "./native-image";
import { bgraPremultiplied, decodePng } from "./png";

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, "latin1");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, tail]);
}

/** A PNG of `rows` (each a flat array of channel bytes), every row filtered with `filters[y]`. */
function png(
	width: number,
	colorType: number,
	channels: number,
	rows: number[][],
	filters: number[],
	extra: Buffer[] = [],
): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(rows.length, 4);
	ihdr[8] = 8;
	ihdr[9] = colorType;
	const stride = width * channels;
	const filtered: number[] = [];
	rows.forEach((row, y) => {
		const above = y > 0 ? rows[y - 1] : null;
		filtered.push(filters[y]);
		row.forEach((value, x) => {
			const left = x >= channels ? row[x - channels] : 0;
			const up = above ? above[x] : 0;
			const upLeft = above && x >= channels ? above[x - channels] : 0;
			const p = left + up - upLeft;
			const paeth = (() => {
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			})();
			const predictor = [0, left, up, (left + up) >> 1, paeth][filters[y]];
			filtered.push((value - predictor) & 0xff);
		});
		expect(row.length).toBe(stride);
	});
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		...extra,
		chunk("IDAT", deflateSync(Buffer.from(filtered))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe("decodePng", () => {
	it("reads RGBA through every filter type", () => {
		const rows = [
			[10, 20, 30, 255, 200, 100, 50, 128],
			[11, 22, 33, 255, 190, 90, 40, 64],
			[12, 24, 36, 200, 180, 80, 30, 32],
			[13, 26, 39, 100, 170, 70, 20, 16],
			[14, 28, 42, 50, 160, 60, 10, 8],
		];
		const decoded = decodePng(png(2, 6, 4, rows, [0, 1, 2, 3, 4]));
		expect([decoded.width, decoded.height]).toEqual([2, 5]);
		expect([...decoded.rgba]).toEqual(rows.flat());
	});

	it("reads RGB, gray, gray+alpha and palette as RGBA", () => {
		expect([...decodePng(png(1, 2, 3, [[1, 2, 3]], [0])).rgba]).toEqual([1, 2, 3, 255]);
		expect([...decodePng(png(1, 0, 1, [[7]], [0])).rgba]).toEqual([7, 7, 7, 255]);
		expect([...decodePng(png(1, 4, 2, [[9, 77]], [0])).rgba]).toEqual([9, 9, 9, 77]);
		const palette = [chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])), chunk("tRNS", Buffer.from([255, 100]))];
		expect([...decodePng(png(2, 3, 1, [[0, 1]], [0], palette)).rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 100]);
	});

	it("refuses what it cannot read", () => {
		expect(() => decodePng(Buffer.from("nope"))).toThrow("Not a PNG");
	});
});

describe("toBitmap", () => {
	it("is BGRA with premultiplied alpha", () => {
		expect([...bgraPremultiplied(Buffer.from([200, 100, 50, 128]))]).toEqual([25, 50, 100, 128]);
		const image = NativeImage.createFromBuffer(png(1, 6, 4, [[255, 0, 0, 255]], [0]));
		expect([...image.toBitmap()]).toEqual([0, 0, 255, 255]);
		expect(() => NativeImage.createEmpty().toBitmap()).toThrow();
	});
});
