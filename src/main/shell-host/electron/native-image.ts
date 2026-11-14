/**
 * `nativeImage` for what main does with images: icons from a file or a data URL (the dock, the tray) and the picture
 * of a page capture (PNG bytes the shell's CDP gave). There is no bitmap codec in main: an image made from bytes
 * keeps them.
 */
import { readFileSync } from "node:fs";
import { bgraPremultiplied, decodePng } from "./png";

export interface ImageSize {
	width: number;
	height: number;
}

export type ImageFormat = "png" | "jpeg";

interface Representation {
	scaleFactor: number;
	dataURL: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from an image file's header; null when it is neither PNG nor JPEG. */
export function sniffImage(data: Uint8Array): { format: ImageFormat; size: ImageSize } | null {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return { format: "png", size: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } };
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1];
			if (marker === 0xff) {
				offset += 1;
				continue;
			}
			// SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return {
					format: "jpeg",
					size: { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) },
				};
			}
			offset += 2 + bytes.readUInt16BE(offset + 2);
		}
		return null;
	}
	return null;
}

export class NativeImage {
	readonly #bytes: Buffer | null;
	readonly #format: ImageFormat | null;
	readonly #size: ImageSize;
	readonly #representations: Representation[] = [];
	#template = false;

	private constructor(bytes: Buffer | null, format: ImageFormat | null, size: ImageSize) {
		this.#bytes = bytes;
		this.#format = format;
		this.#size = size;
	}

	static createEmpty(): NativeImage {
		return new NativeImage(null, null, { width: 0, height: 0 });
	}

	static createFromBuffer(data: Buffer): NativeImage {
		const sniffed = sniffImage(data);
		if (!sniffed) return NativeImage.createEmpty();
		return new NativeImage(Buffer.from(data), sniffed.format, sniffed.size);
	}

	static createFromPath(path: string): NativeImage {
		try {
			return NativeImage.createFromBuffer(readFileSync(path));
		} catch {
			return NativeImage.createEmpty();
		}
	}

	static createFromDataURL(dataURL: string): NativeImage {
		const match = /^data:[^;,]*(;base64)?,(.*)$/s.exec(dataURL);
		if (!match) return NativeImage.createEmpty();
		const body = match[1] ? Buffer.from(match[2], "base64") : Buffer.from(decodeURIComponent(match[2]), "latin1");
		return NativeImage.createFromBuffer(body);
	}

	isEmpty(): boolean {
		return this.#size.width === 0 || this.#size.height === 0;
	}

	getSize(): ImageSize {
		return { ...this.#size };
	}

	getAspectRatio(): number {
		return this.#size.height === 0 ? 1 : this.#size.width / this.#size.height;
	}

	toPNG(): Buffer {
		if (this.#bytes && this.#format === "png") return Buffer.from(this.#bytes);
		throw new Error("This image is not PNG bytes here: main has no bitmap codec");
	}

	toJPEG(_quality?: number): Buffer {
		if (this.#bytes && this.#format === "jpeg") return Buffer.from(this.#bytes);
		throw new Error("This image is not JPEG bytes here: main has no bitmap codec");
	}

	/** BGRA, premultiplied, row-major, as Electron's; decoded from the PNG the shell captured. */
	toBitmap(): Buffer {
		if (!this.#bytes || this.#format !== "png") throw new Error("This image has no PNG bytes to read pixels from");
		return bgraPremultiplied(decodePng(this.#bytes).rgba);
	}

	toDataURL(): string {
		if (!this.#bytes || !this.#format) return "data:image/png;base64,";
		return `data:image/${this.#format};base64,${this.#bytes.toString("base64")}`;
	}

	/** The same image: another size needs a bitmap codec, which main has none of. */
	resize(options: { width?: number; height?: number; quality?: string }): NativeImage {
		const width = options.width ?? Math.round((options.height ?? this.#size.height) * this.getAspectRatio());
		if (width === this.#size.width) return this;
		throw new Error("This image cannot be resized here: main has no bitmap codec");
	}

	addRepresentation(representation: { scaleFactor?: number; dataURL?: string; buffer?: Buffer }): void {
		const dataURL =
			representation.dataURL ??
			(representation.buffer ? `data:image/png;base64,${representation.buffer.toString("base64")}` : undefined);
		if (dataURL) this.#representations.push({ scaleFactor: representation.scaleFactor ?? 1, dataURL });
	}

	setTemplateImage(template: boolean): void {
		this.#template = template;
	}

	isTemplateImage(): boolean {
		return this.#template;
	}

	/** The representations a tray icon is sent as: this image at scale 1, then each added one. */
	representations(): Representation[] {
		return [...(this.#bytes ? [{ scaleFactor: 1, dataURL: this.toDataURL() }] : []), ...this.#representations];
	}

	/** The bytes as they are held, when the image was made from bytes. */
	bytes(): Buffer | null {
		return this.#bytes;
	}
}
