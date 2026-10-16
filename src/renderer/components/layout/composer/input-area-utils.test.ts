import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileToImage, IMAGE_MAX_SIDE } from "./input-area-utils";

/** FileReader stand-in (Node has none): `readAsDataURL` over the blob's bytes. */
class FakeFileReader {
	result: string | null = null;
	error: Error | null = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(blob: Blob): void {
		void blob.arrayBuffer().then(buffer => {
			this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
			this.onload?.();
		});
	}
}

let bitmapSize = { width: 4000, height: 2000 };
const drawn: { width: number; height: number }[] = [];
const closed = vi.fn();

class FakeOffscreenCanvas {
	constructor(
		readonly width: number,
		readonly height: number,
	) {}
	getContext() {
		return {
			imageSmoothingQuality: "low",
			drawImage: (_bitmap: unknown, _x: number, _y: number, width: number, height: number) =>
				drawn.push({ width, height }),
		};
	}
	async convertToBlob({ type }: { type: string }) {
		return new Blob([new Uint8Array([9, 9])], { type });
	}
}

beforeEach(() => {
	bitmapSize = { width: 4000, height: 2000 };
	drawn.length = 0;
	closed.mockClear();
	vi.stubGlobal("FileReader", FakeFileReader);
	vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => ({ ...bitmapSize, close: closed })),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("fileToImage", () => {
	it("scales a picture larger than the cap down to it, keeping its format", async () => {
		const image = await fileToImage(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
		expect(drawn).toEqual([{ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE / 2 }]);
		expect(image.content).toEqual({ type: "image", data: "CQk=", mimeType: "image/png" });
		expect(image.preview).toBe("data:image/png;base64,CQk=");
		expect(closed).toHaveBeenCalled();
	});

	it("keeps a picture that already fits, and a GIF, byte for byte", async () => {
		bitmapSize = { width: 800, height: 600 };
		const small = await fileToImage(new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
		expect(small.content).toEqual({ type: "image", data: "AQID", mimeType: "image/jpeg" });
		bitmapSize = { width: 4000, height: 4000 };
		const gif = await fileToImage(new File([new Uint8Array([1, 2, 3])], "a.gif", { type: "image/gif" }));
		expect(gif.content.mimeType).toBe("image/gif");
		expect(drawn).toEqual([]);
	});
});
