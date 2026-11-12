/**
 * `nativeImage` for what main does with images: icons from a file or a data URL (the dock, the tray), and the
 * pictures of a page: a capture (PNG bytes the shell's CDP gave) and a paint of an offscreen page (a frame the shell
 * still holds, read with `wc.frame` when something is sent). There is no bitmap codec in main: an image made from
 * bytes keeps them, and what needs another size or another format is asked of the shell at the source
 * (`Page.captureScreenshot` with a clip scale, `wc.frame` with a width and a format) through `encodeImage`.
 */
import { readFileSync } from "node:fs";
import type { HostClient } from "./host";
import { bgraPremultiplied, decodePng } from "./png";

export interface ImageSize {
	width: number;
	height: number;
}

export type ImageFormat = "png" | "jpeg";

/** What `encodeImage` asks for; `width` scales down (never up), keeping the aspect ratio. */
export interface EncodeOptions {
	format: ImageFormat;
	/** JPEG quality, 0..100. */
	quality?: number;
	width?: number;
}

/** Where a frame's pixels live: asked for in a format and a width when something is sent. */
export interface FrameSource {
	read(options: EncodeOptions): Promise<{ data: Buffer; width: number; height: number }>;
}

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
	readonly #frame: FrameSource | null;
	/** A capture's way to be taken again at another scale (the page's own clip scale, no bitmap resize). */
	#rescale: ((ratio: number) => Promise<Buffer>) | null = null;
	readonly #representations: Representation[] = [];
	#template = false;

	private constructor(bytes: Buffer | null, format: ImageFormat | null, size: ImageSize, frame: FrameSource | null) {
		this.#bytes = bytes;
		this.#format = format;
		this.#size = size;
		this.#frame = frame;
	}

	static createEmpty(): NativeImage {
		return new NativeImage(null, null, { width: 0, height: 0 }, null);
	}

	static createFromBuffer(data: Buffer): NativeImage {
		const sniffed = sniffImage(data);
		if (!sniffed) return NativeImage.createEmpty();
		return new NativeImage(Buffer.from(data), sniffed.format, sniffed.size, null);
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

	/** An image the shell holds (an offscreen page's latest paint): its size is known, its pixels are asked for. */
	static fromFrame(size: ImageSize, frame: FrameSource): NativeImage {
		return new NativeImage(null, null, size, frame);
	}

	/** The picture of a capture: PNG bytes the shell encoded; `rescale(ratio)` takes it again at `ratio` × its size. */
	static fromCapture(png: Buffer, rescale?: (ratio: number) => Promise<Buffer>): NativeImage {
		const image = NativeImage.createFromBuffer(png);
		if (rescale) image.#rescale = rescale;
		return image;
	}

	/**
	 * This capture no wider than `width` pixels: taken again by the page at the smaller scale (there is no bitmap
	 * codec here). An image that is narrower already, or not a capture, is returned as it is.
	 */
	async fitted(width: number): Promise<NativeImage> {
		if (this.#size.width <= width || !this.#rescale) return this;
		let ratio = width / this.#size.width;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const taken = NativeImage.createFromBuffer(await this.#rescale(ratio));
			// A display with a pixel ratio above 1 captures wider than the scale says: once more, corrected.
			if (taken.#size.width <= width * 1.02 || attempt === 1) {
				taken.#rescale = this.#rescale;
				return taken;
			}
			ratio *= width / taken.#size.width;
		}
		return this;
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
		throw new Error("This image is not PNG bytes here: ask for the encoding with encodeImage()");
	}

	toJPEG(_quality?: number): Buffer {
		if (this.#bytes && this.#format === "jpeg") return Buffer.from(this.#bytes);
		throw new Error("This image is not JPEG bytes here: ask for the encoding with encodeImage()");
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

	/** The same image: a different size needs the source (`encodeImage` with `width`). */
	resize(options: { width?: number; height?: number; quality?: string }): NativeImage {
		const width = options.width ?? Math.round((options.height ?? this.#size.height) * this.getAspectRatio());
		if (width === this.#size.width) return this;
		if (!this.#frame) throw new Error("This image cannot be resized here: ask for the size with encodeImage()");
		const height = Math.max(1, Math.round(width / this.getAspectRatio()));
		const source = this.#frame;
		return new NativeImage(
			null,
			null,
			{ width, height },
			{
				read: ({ width: narrower, ...rest }) =>
					source.read({ ...rest, width: narrower === undefined ? width : Math.min(narrower, width) }),
			},
		);
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

	/** The bytes as they are held, when the image was made from bytes; null for a frame. */
	bytes(): Buffer | null {
		return this.#bytes;
	}

	/** Encodes in `format` (scaled to `width`): from the source for a frame, as held for bytes already in it. */
	async encode(options: EncodeOptions): Promise<Buffer> {
		if (this.#frame) return (await this.#frame.read(options)).data;
		if (
			this.#bytes &&
			this.#format === options.format &&
			(options.width === undefined || options.width >= this.#size.width)
		)
			return Buffer.from(this.#bytes);
		throw new Error(`This image cannot be encoded as ${options.format} at that size here`);
	}
}

/** `capturePage` for an offscreen page's frame: `wc.frame` answers the bytes and the size. */
export function frameSource(client: HostClient, wcId: number): FrameSource {
	return {
		async read({ format, quality, width }) {
			const answer = await client.request<{ width: number; height: number }>("wc.frame", {
				wcId,
				format,
				...(quality === undefined ? {} : { quality }),
				...(width === undefined ? {} : { width }),
			});
			return { data: answer.bin ?? Buffer.alloc(0), width: answer.result.width, height: answer.result.height };
		},
	};
}
